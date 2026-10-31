// Спільні заглушки мережі для тестів. Це не тест (немає .test у назві).

export const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export const text = (body: string, status = 200): Response => new Response(body, { status });

/** fetch, що ніколи не відповідає, але чесно реагує на abort. */
export function hang(_url: unknown, { signal }: { signal?: AbortSignal | null }): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    // У Node таймер AbortSignal.timeout "unref'd" і не тримає event loop.
    const keepAlive = setTimeout(() => {}, 60_000);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(keepAlive);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export interface Call {
  url: RequestInfo | URL;
  signal: AbortSignal | null | undefined;
}

export type NetworkHandler = (url: RequestInfo | URL, init: RequestInit, callCount: number) => Response | Promise<Response>;

export interface FakeFetch {
  (url: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: Call[];
  count(url: string): number;
}

/** Фейкова мережа: рахує виклики й дозволяє керувати відповіддю по url. */
export function fakeNetwork(handler: NetworkHandler): FakeFetch {
  const calls: Call[] = [];
  const impl = async (url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, signal: init.signal });
    return handler(url, init, calls.filter((c) => c.url === url).length);
  };
  // as: приклеюємо calls/count до функції-заглушки (лише для тестів)
  const fetch = impl as FakeFetch;
  fetch.calls = calls;
  fetch.count = (url: string) => calls.filter((c) => c.url === url).length;
  return fetch;
}

export const settleTicks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
