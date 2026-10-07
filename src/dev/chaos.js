import { sleep } from '../assets/loader.js';

/**
 * Режим хаосу для демонстрації та захисту: підміняє fetch і штучно ламає
 * мережу, щоб побачити, як гра переживає збої. Вмикається параметром URL:
 *
 *   ?chaos=slow                   кожен ассет іде 250–600 мс (видно прогрес-бар)
 *   ?chaos=sprite404[:n]          sprites.png → 404 перші n разів (за замовчуванням
 *                                 завжди; sprite404:1 — "Повторити" вже спрацює)
 *   ?chaos=audio404               звуки → 404 (optional: гра стартує без звуку)
 *   ?chaos=flaky                  кожен ассет спершу 2 рази відповідає 503 (ретраї)
 *   ?chaos=timeout[:n]            перші n запитів /api/rooms зависають (таймаут)
 *   ?chaos=badjson[:n]            перші n відповідей /api/rooms — зламаний JSON
 *   ?chaos=rooms500[:n]           перші n відповідей /api/rooms — HTTP 500
 *
 * Режими комбінуються комами: ?chaos=slow,flaky. Усі відповіді синтетичні
 * (new Response), тому поведінка не залежить від dev-сервера.
 */
// Скільки разів режим спрацьовує, якщо `:n` не вказано.
const DEFAULT_COUNT = {
  slow: Infinity,
  sprite404: Infinity,
  audio404: Infinity,
};

export function parseChaos(spec) {
  const modes = new Map();

  for (const part of String(spec ?? '').split(',')) {
    const [name, count] = part.trim().split(':');
    if (!name) continue;

    modes.set(
      name,
      count === undefined ? (DEFAULT_COUNT[name] ?? 2) : Number(count) || 0,
    );
  }
  return modes;
}

export function createChaosFetch(
  spec,
  realFetch = (...args) => globalThis.fetch(...args),
) {
  const modes = parseChaos(spec);
  const seen = new Map(); // url → скільки разів уже просили

  const bump = (key) => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count;
  };
  const log = (message) => console.info(`[chaos] ${message}`);

  /** Запит, що ніколи не відповідає; завершується лише через abort/timeout. */
  const hang = (signal) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });

  return async function chaosFetch(input, init = {}) {
    const url = new URL(String(input), globalThis.location.href);
    const path = url.pathname;
    const isAsset =
      path.startsWith('/assets/') && !path.endsWith('manifest.json');
    const isRooms = path === '/api/rooms';
    const attempt = bump(path);

    if (isAsset && modes.has('slow')) {
      const ms = 250 + Math.random() * 350;
      log(`slow: ${path} затримано на ${Math.round(ms)} мс`);
      await sleep(ms, init.signal);
    }

    if (
      path.endsWith('sprites.png') &&
      modes.has('sprite404') &&
      attempt <= modes.get('sprite404')
    ) {
      log(`sprite404: ${path} → 404`);
      return new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
      });
    }

    if (path.endsWith('.wav') && modes.has('audio404')) {
      log(`audio404: ${path} → 404`);
      return new Response('Not Found', {
        status: 404,
        statusText: 'Not Found',
      });
    }

    if (isAsset && modes.has('flaky') && attempt <= modes.get('flaky')) {
      log(`flaky: ${path} спроба ${attempt} → 503`);
      return new Response('Unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      });
    }

    if (isRooms) {
      if (modes.has('timeout') && attempt <= modes.get('timeout')) {
        log(`timeout: ${path} запит ${attempt} зависає`);
        return hang(init.signal);
      }
      if (modes.has('badjson') && attempt <= modes.get('badjson')) {
        log(`badjson: ${path} запит ${attempt} → зламаний JSON`);
        return new Response('[{"id": "training", "name": ', { status: 200 });
      }
      if (modes.has('rooms500') && attempt <= modes.get('rooms500')) {
        log(`rooms500: ${path} запит ${attempt} → 500`);
        return new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        });
      }
    }

    return realFetch(input, init);
  };
}
