/**
 * Конвеєр ассетів: fetch → перевірка `ok` → декодування, усе з AbortSignal.
 * Усі функції приймають `{ fetch }`, тому в тестах мережу підміняє заглушка.
 */

// ------------------------------------------------------------------ помилки

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number, statusText = '') {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''} — ${url}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
  }
}

export class BadJsonError extends Error {
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(`Некоректний JSON — ${url}`, { cause });
    this.name = 'BadJsonError';
    this.url = url;
  }
}

export class DecodeError extends Error {
  readonly url: string;
  constructor(url: string, cause: unknown) {
    super(`Не вдалося декодувати — ${url}`, { cause });
    this.name = 'DecodeError';
    this.url = url;
  }
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const errName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

// ----------------------------------------------------------------- утиліти

export function mergeSignals(...signals: (AbortSignal | null | undefined)[]): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);

  const controller = new AbortController();
  for (const source of list) {
    if (source.aborted) {
      controller.abort(source.reason);
      break;
    }
    source.addEventListener('abort', () => controller.abort(source.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}

/** Пауза, яку можна перервати: abort одразу відхиляє проміс і гасить таймер. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ------------------------------------------------------------------- fetch

export interface FetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export async function fetchChecked(url: string, { signal, timeoutMs, fetch: fetchImpl = globalThis.fetch }: FetchOptions = {}): Promise<Response> {
  const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const requestSignal = mergeSignals(signal, timeoutSignal);

  const response = await fetchImpl(url, { signal: requestSignal });
  if (!response.ok) throw new HttpError(url, response.status, response.statusText);
  return response;
}

export async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
  const response = await fetchChecked(url, options);
  try {
    return await response.json();
  } catch (error: unknown) {
    // abort під час читання тіла — це не "битий JSON", пропускаємо як є
    if (errName(error) === 'AbortError' || errName(error) === 'TimeoutError') throw error;
    throw new BadJsonError(url, error);
  }
}

// ------------------------------------------------------------------- retry

export function isRetryable(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (error instanceof HttpError) return error.status >= 500;
  if (errName(error) === 'TimeoutError') return true;
  return error instanceof TypeError;
}

export interface RetryInfo {
  attempt: number;
  error: unknown;
  delayMs: number;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (error: unknown, signal?: AbortSignal) => boolean;
  onRetry?: (info: RetryInfo) => void;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RetryContext {
  attempt: number;
  signal?: AbortSignal;
}

export async function withRetry<T>(
  fn: (ctx: RetryContext) => T | Promise<T>,
  { attempts = 3, baseMs = 250, maxMs = 4000, signal, shouldRetry = isRetryable, onRetry, random = Math.random, sleep: sleepImpl = sleep }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn({ attempt, signal });
    } catch (error: unknown) {
      if (attempt >= attempts || !shouldRetry(error, signal)) throw error;
      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delayMs = random() * ceiling;
      onRetry?.({ attempt, error, delayMs });
      await sleepImpl(delayMs, signal);
    }
  }
}

const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseMs: 250, maxMs: 3000 };
const DEFAULT_TIMEOUT_MS = 8000;

export interface LoadOptions extends FetchOptions {
  retry?: RetryOptions | false;
}

function run<T>(task: (ctx: RetryContext) => Promise<T>, { signal, retry = DEFAULT_RETRY }: LoadOptions = {}): Promise<T> {
  return retry === false ? task({ attempt: 1, signal }) : withRetry(task, { ...retry, signal });
}

// ----------------------------------------------------------------- лоадери

export function loadJson(url: string, options: LoadOptions = {}): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return run(() => fetchJson(url, { ...options, timeoutMs }), options);
}

export interface ImageLoadOptions<T = ImageBitmap> extends LoadOptions {
  decodeImage?: (blob: Blob) => Promise<T>;
}

export function loadImage<T = ImageBitmap>(url: string, options: ImageLoadOptions<T> = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, decodeImage, signal } = options;
  // as: запасний декодер — createImageBitmap, коли власний не задано (T = ImageBitmap)
  const decode = decodeImage ?? ((blob: Blob) => createImageBitmap(blob) as Promise<T>);
  return run(async () => {
    const response = await fetchChecked(url, { ...options, timeoutMs });
    const blob = await response.blob();
    signal?.throwIfAborted();
    try {
      return await decode(blob);
    } catch (cause: unknown) {
      throw new DecodeError(url, cause);
    }
  }, options);
}

export interface AudioDecoder<T = AudioBuffer> {
  decodeAudioData(data: ArrayBuffer): Promise<T>;
}

export function loadAudio<T = AudioBuffer>(audioContext: AudioDecoder<T>, url: string, options: LoadOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;
  return run(async () => {
    const response = await fetchChecked(url, { ...options, timeoutMs });
    const data = await response.arrayBuffer();
    signal?.throwIfAborted();
    try {
      return await audioContext.decodeAudioData(data);
    } catch (cause: unknown) {
      throw new DecodeError(url, cause);
    }
  }, options);
}

// ---------------------------------------------------------------- manifest

export type AssetType = 'image' | 'audio' | 'json';

export interface AssetEntry {
  key: string;
  type: AssetType;
  url: string;
  optional?: boolean;
}

export interface Manifest {
  assets: AssetEntry[];
}

export function validateManifest(manifest: unknown): Manifest {
  const root = asRecord(manifest);
  if (!root || !Array.isArray(root['assets'])) {
    throw new ManifestError('manifest.json: очікується { "assets": [...] }');
  }

  const keys = new Set<string>();
  const assets: AssetEntry[] = [];
  for (const entry of root['assets']) {
    const rec = asRecord(entry);
    const key = rec?.['key'];
    const type = rec?.['type'];
    const url = rec?.['url'];
    if (typeof key !== 'string' || typeof url !== 'string' || (type !== 'image' && type !== 'audio' && type !== 'json')) {
      throw new ManifestError(`manifest.json: некоректний запис ${JSON.stringify(entry)}`);
    }
    if (keys.has(key)) throw new ManifestError(`manifest.json: дубль ключа "${key}"`);
    keys.add(key);
    assets.push({ key, type, url, optional: rec?.['optional'] === true });
  }
  return { assets };
}

export interface LoadProgress {
  entry: AssetEntry;
  ok: boolean;
  done: number;
  total: number;
}

export interface FailedAsset {
  entry: AssetEntry;
  error: unknown;
}

export interface LoadedAssets {
  images: Record<string, ImageBitmap | null>;
  audio: Record<string, AudioBuffer | null>;
  json: Record<string, unknown>;
  failed: FailedAsset[];
}

export interface LoadAllOptions extends LoadOptions {
  audioContext?: AudioContext;
  decodeImage?: (blob: Blob) => Promise<ImageBitmap>;
  onProgress?: (fraction: number, info: LoadProgress) => void;
  onRetry?: (entry: AssetEntry, info: RetryInfo) => void;
}

/** Вантажить усе з маніфесту ОДНОЧАСНО (Promise.all) і звітує про прогрес по кожному файлу. */
export async function loadAll(manifest: unknown, { audioContext, onProgress, onRetry, signal, ...loaderOptions }: LoadAllOptions = {}): Promise<LoadedAssets> {
  const valid = validateManifest(manifest);
  signal?.throwIfAborted();

  const entries = valid.assets;
  const total = entries.length;
  const controller = new AbortController();
  const sharedSignal = mergeSignals(signal, controller.signal);

  let done = 0;
  const failed: FailedAsset[] = [];

  const optionsFor = (entry: AssetEntry): ImageLoadOptions => ({
    ...loaderOptions,
    ...(sharedSignal ? { signal: sharedSignal } : {}),
    retry:
      loaderOptions.retry === false
        ? false
        : { ...DEFAULT_RETRY, ...loaderOptions.retry, onRetry: (info) => onRetry?.(entry, info) },
  });

  const loadEntry = (entry: AssetEntry): Promise<ImageBitmap | AudioBuffer | unknown> => {
    const options = optionsFor(entry);
    switch (entry.type) {
      case 'image':
        return loadImage(entry.url, options);
      case 'audio':
        if (!audioContext) throw new Error('loadAll: audioContext потрібен для звуку');
        return loadAudio(audioContext, entry.url, options);
      default:
        return loadJson(entry.url, options);
    }
  };

  const tasks = entries.map(async (entry): Promise<[AssetEntry, unknown]> => {
    let value: unknown = null;
    let ok = true;
    try {
      value = await loadEntry(entry);
    } catch (error: unknown) {
      // optional-ассет тихо перетворюється на null — але не при abort
      if (!entry.optional || sharedSignal?.aborted) throw error;
      ok = false;
      failed.push({ entry, error });
    }
    done += 1;
    onProgress?.(done / total, { entry, ok, done, total });
    return [entry, value];
  });

  let results: [AssetEntry, unknown][];
  try {
    results = await Promise.all(tasks);
  } catch (error: unknown) {
    controller.abort(error); // скасувати файли, що ще вантажаться
    throw error;
  }

  const assets: LoadedAssets = { images: {}, audio: {}, json: {}, failed };
  for (const [entry, value] of results) {
    if (entry.type === 'image') assets.images[entry.key] = (value as ImageBitmap | null) ?? null;
    else if (entry.type === 'audio') assets.audio[entry.key] = (value as AudioBuffer | null) ?? null;
    else assets.json[entry.key] = value;
  }
  return assets;
}
