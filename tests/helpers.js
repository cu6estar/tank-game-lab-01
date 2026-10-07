// Спільні заглушки мережі для тестів. Це не тест (немає .test.js у назві).

export const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const text = (body, status = 200) => new Response(body, { status });

/** fetch, що ніколи не відповідає, але чесно реагує на abort. */
export function hang(url, { signal }) {
  return new Promise((resolve, reject) => {
    // У Node таймер AbortSignal.timeout "unref'd" і не тримає event loop,
    // тож без власного таймера процес завершився б, поки запит ще висить.
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

/** Фейкова мережа: рахує виклики й дозволяє керувати відповіддю по url. */
export function fakeNetwork(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, signal: init.signal });
    return handler(url, init, calls.filter((c) => c.url === url).length);
  };
  fetch.calls = calls;
  fetch.count = (url) => calls.filter((c) => c.url === url).length;
  return fetch;
}

export const settleTicks = () =>
  new Promise((resolve) => setImmediate(resolve));

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
