/**
 * Конвеєр ассетів: fetch → перевірка `ok` → декодування, усе з AbortSignal.
 *
 *   fetchChecked / fetchJson   спільна основа: кидають HttpError, якщо !response.ok
 *   loadImage / loadAudio / loadJson   по одному ассету
 *   withRetry                  exponential backoff + jitter, без ретраю на 4xx
 *   loadAll                    Promise.all з прогресом по кожному файлу
 *
 * Усі функції приймають `{ fetch }`, тому в тестах мережу підміняє заглушка.
 */

// ------------------------------------------------------------------ помилки

/** Сервер відповів, але зі статусом поза 200–299. fetch сам такого не кидає. */
export class HttpError extends Error {
  constructor(url, status, statusText = '') {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''} — ${url}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

/** Відповідь прийшла, але це не валідний JSON. Повтор нічого не змінить. */
export class BadJsonError extends Error {
  constructor(url, cause) {
    super(`Некоректний JSON — ${url}`, { cause });
    this.name = 'BadJsonError';
    this.url = url;
  }
}

/** Байти отримані, але браузер не зміг їх декодувати (картинка/звук битий). */
export class DecodeError extends Error {
  constructor(url, cause) {
    super(`Не вдалося декодувати — ${url}`, { cause });
    this.name = 'DecodeError';
    this.url = url;
  }
}

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestError';
  }
}

// ----------------------------------------------------------------- утиліти

/**
 * Один сигнал із кількох: спрацьовує, коли спрацює будь-який із вхідних.
 * AbortSignal.any є в Chrome 116+, нижче — запасний варіант вручну.
 */
export function mergeSignals(...signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const controller = new AbortController();
  for (const source of list) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), {
      once: true,
      signal: controller.signal,
    });
  }
  return controller.signal;
}

/** Пауза, яку можна перервати: abort одразу відхиляє проміс і гасить таймер. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------------------------- fetch

/**
 * fetch, який нарешті поводиться як очікуєш: 404 і 500 стають помилкою.
 * `timeoutMs` — стеля на ВЕСЬ запит (разом із читанням тіла), окремо для
 * кожної спроби, бо сигнал створюється тут, а не зовні.
 */
export async function fetchChecked(
  url,
  { signal, timeoutMs, fetch: fetchImpl = globalThis.fetch } = {},
) {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const requestSignal = mergeSignals(signal, timeoutSignal);

  const response = await fetchImpl(url, { signal: requestSignal });
  if (!response.ok) {
    throw new HttpError(url, response.status, response.statusText);
  }
  return response;
}

export async function fetchJson(url, options = {}) {
  const response = await fetchChecked(url, options);

  try {
    return await response.json();
  } catch (error) {
    // abort під час читання тіла — це не "битий JSON", пропускаємо як є
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw error;
    }
    throw new BadJsonError(url, error);
  }
}

// ------------------------------------------------------------------- retry

/**
 * Що вважаємо тимчасовим збоєм (варто повторити):
 *   — 5xx, мережева помилка (fetch кидає TypeError), таймаут запиту.
 * Не повторюємо: 4xx (клієнт сам винен — запит не зміниться), битий JSON,
 * помилку декодування та будь-який abort, який зробили ми самі.
 */
export function isRetryable(error, signal) {
  if (signal?.aborted) return false;
  if (error instanceof HttpError) return error.status >= 500;
  if (error?.name === 'TimeoutError') return true;
  return error instanceof TypeError;
}

/**
 * Повторює `fn`, чекаючи між спробами експоненційно довше + випадково
 * ("full jitter": пауза = random(0, min(maxMs, baseMs · 2^(спроба-1)))).
 * Jitter потрібен, щоб клієнти, які впали одночасно, не повторили одночасно.
 */
export async function withRetry(
  fn,
  {
    attempts = 3,
    baseMs = 250,
    maxMs = 4000,
    signal,
    shouldRetry = isRetryable,
    onRetry,
    random = Math.random,
    sleep: sleepImpl = sleep,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();

    try {
      return await fn({ attempt, signal });
    } catch (error) {
      if (attempt >= attempts || !shouldRetry(error, signal)) throw error;

      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delayMs = random() * ceiling;

      onRetry?.({ attempt, error, delayMs });
      await sleepImpl(delayMs, signal);
    }
  }
}

const DEFAULT_RETRY = { attempts: 3, baseMs: 250, maxMs: 3000 };
const DEFAULT_TIMEOUT_MS = 8000;

/** Запускає завдання з ретраєм (або без, якщо `retry: false`). */
function run(task, { signal, retry = DEFAULT_RETRY } = {}) {
  return retry === false ? task() : withRetry(task, { ...retry, signal });
}

// ----------------------------------------------------------------- лоадери

export function loadJson(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return run(() => fetchJson(url, { ...options, timeoutMs }), options);
}

/**
 * Картинка через fetch → Blob → createImageBitmap, а не `new Image()`:
 * лише так видно HTTP-статус (щоб не ретраїти 404) і працює abort.
 */
export function loadImage(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    decodeImage = (blob) => createImageBitmap(blob),
    signal,
  } = options;

  return run(async () => {
    const response = await fetchChecked(url, { ...options, timeoutMs });
    const blob = await response.blob();
    signal?.throwIfAborted();

    try {
      return await decodeImage(blob);
    } catch (cause) {
      throw new DecodeError(url, cause);
    }
  }, options);
}

/**
 * Звук: fetch → ArrayBuffer → decodeAudioData (асинхронно, поза головним
 * потоком). Декодуємо на екрані завантаження, а не при першому пострілі.
 */
export function loadAudio(audioContext, url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  return run(async () => {
    const response = await fetchChecked(url, { ...options, timeoutMs });
    const data = await response.arrayBuffer();
    signal?.throwIfAborted();

    try {
      return await audioContext.decodeAudioData(data);
    } catch (cause) {
      throw new DecodeError(url, cause);
    }
  }, options);
}

// ---------------------------------------------------------------- manifest

export function validateManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.assets)) {
    throw new ManifestError('manifest.json: очікується { "assets": [...] }');
  }

  const keys = new Set();
  for (const entry of manifest.assets) {
    const { key, type, url } = entry ?? {};
    if (!key || !url || !['image', 'audio', 'json'].includes(type)) {
      throw new ManifestError(
        `manifest.json: некоректний запис ${JSON.stringify(entry)}`,
      );
    }
    if (keys.has(key)) {
      throw new ManifestError(`manifest.json: дубль ключа "${key}"`);
    }
    keys.add(key);
  }
  return manifest;
}

/**
 * Вантажить усе з маніфесту ОДНОЧАСНО (Promise.all) і звітує про прогрес
 * по кожному завершеному файлу: onProgress(done / total, { entry, ok }).
 *
 * Promise.all відхиляється на першій помилці, але не скасовує решту —
 * тому ми самі абортимо спільний контролер, щоб "брати" не качали далі.
 * Ассети з `optional: true` при збої дають null і не валять завантаження.
 */
export async function loadAll(
  manifest,
  { audioContext, onProgress, onRetry, signal, ...loaderOptions } = {},
) {
  validateManifest(manifest);
  signal?.throwIfAborted();

  const entries = manifest.assets;
  const total = entries.length;
  const controller = new AbortController();
  const sharedSignal = mergeSignals(signal, controller.signal);

  let done = 0;
  const failed = [];

  const loadEntry = (entry) => {
    const options = {
      ...loaderOptions,
      signal: sharedSignal,
      retry:
        loaderOptions.retry === false
          ? false
          : {
              ...DEFAULT_RETRY,
              ...loaderOptions.retry,
              onRetry: (info) => onRetry?.(entry, info),
            },
    };

    switch (entry.type) {
      case 'image':
        return loadImage(entry.url, options);
      case 'audio':
        return loadAudio(audioContext, entry.url, options);
      default:
        return loadJson(entry.url, options);
    }
  };

  const tasks = entries.map(async (entry) => {
    let value = null;
    let ok = true;

    try {
      value = await loadEntry(entry);
    } catch (error) {
      // optional-ассет тихо перетворюється на null — але не при abort
      if (!entry.optional || sharedSignal.aborted) throw error;
      ok = false;
      failed.push({ entry, error });
    }

    done += 1;
    onProgress?.(done / total, { entry, ok, done, total });
    return [entry, value];
  });

  let results;
  try {
    results = await Promise.all(tasks);
  } catch (error) {
    controller.abort(error); // скасувати файли, що ще вантажаться
    throw error;
  }

  const assets = { images: {}, audio: {}, json: {}, failed };
  for (const [entry, value] of results) {
    const bucket = { image: 'images', audio: 'audio', json: 'json' }[
      entry.type
    ];
    assets[bucket][entry.key] = value;
  }
  return assets;
}
