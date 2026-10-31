import { sleep } from '../assets/loader.ts';

/**
 * Режим хаосу для демонстрації та захисту: підміняє fetch і штучно ламає
 * мережу. Вмикається параметром URL (?chaos=slow,flaky тощо). Усі відповіді
 * синтетичні (new Response), тому поведінка не залежить від dev-сервера.
 */
const DEFAULT_COUNT: Record<string, number> = {
  slow: Infinity,
  sprite404: Infinity,
  audio404: Infinity,
};

export function parseChaos(spec: string | null | undefined): Map<string, number> {
  const modes = new Map<string, number>();
  for (const part of String(spec ?? '').split(',')) {
    const [name, count] = part.trim().split(':');
    if (!name) continue;
    modes.set(name, count === undefined ? (DEFAULT_COUNT[name] ?? 2) : Number(count) || 0);
  }
  return modes;
}

export type ChaosFetch = typeof fetch;

export function createChaosFetch(spec: string | null | undefined, realFetch: typeof fetch = (...args) => globalThis.fetch(...args)): ChaosFetch {
  const modes = parseChaos(spec);
  const seen = new Map<string, number>(); // url → скільки разів уже просили

  const bump = (key: string): number => {
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count;
  };
  const limit = (name: string): number => modes.get(name) ?? 0;
  const log = (message: string): void => console.info(`[chaos] ${message}`);

  /** Запит, що ніколи не відповідає; завершується лише через abort/timeout. */
  const hang = (signal?: AbortSignal | null): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  return async function chaosFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input), globalThis.location.href);
    const path = url.pathname;
    const isAsset = path.startsWith('/assets/') && !path.endsWith('manifest.json');
    const isRooms = path === '/api/rooms';
    const attempt = bump(path);

    if (isAsset && modes.has('slow')) {
      const ms = 250 + Math.random() * 350;
      log(`slow: ${path} затримано на ${Math.round(ms)} мс`);
      await sleep(ms, init.signal ?? undefined);
    }

    if (path.endsWith('sprites.png') && modes.has('sprite404') && attempt <= limit('sprite404')) {
      log(`sprite404: ${path} → 404`);
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }

    if (path.endsWith('.wav') && modes.has('audio404')) {
      log(`audio404: ${path} → 404`);
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    }

    if (isAsset && modes.has('flaky') && attempt <= limit('flaky')) {
      log(`flaky: ${path} спроба ${attempt} → 503`);
      return new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' });
    }

    if (isRooms) {
      if (modes.has('timeout') && attempt <= limit('timeout')) {
        log(`timeout: ${path} запит ${attempt} зависає`);
        return hang(init.signal);
      }
      if (modes.has('badjson') && attempt <= limit('badjson')) {
        log(`badjson: ${path} запит ${attempt} → зламаний JSON`);
        return new Response('[{"id": "training", "name": ', { status: 200 });
      }
      if (modes.has('rooms500') && attempt <= limit('rooms500')) {
        log(`rooms500: ${path} запит ${attempt} → 500`);
        return new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' });
      }
    }

    return realFetch(input, init);
  };
}
