// Галерея збоїв завантажувача в Node: локальний сервер ламається п'ятьма
// способами, а ми дивимось, ЩО зробив loadAll (помилка, кількість запитів).
// Браузерну версію з екранами та скриншотами див. docs/screenshots/failure-*.png.
// Запуск: npm run exp:failures
import { createServer } from 'node:http';
import { loadAll } from '../src/assets/loader.js';

const hits = new Map();
const server = createServer((req, res) => {
  hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
  const n = hits.get(req.url);
  switch (req.url.split('?')[0]) {
    case '/ok.json':
      return res.end('{"ok":true}');
    case '/missing.json':
      res.statusCode = 404;
      return res.end();
    case '/broken.json':
      return res.end('{"frames": {');
    case '/flaky.json': // 503, 503, потім ок
      if (n < 3) {
        res.statusCode = 503;
        return res.end();
      }
      return res.end('{"ok":true}');
    case '/hang.json': // ніколи не відповідає
      return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const retry = { attempts: 3, baseMs: 20, maxMs: 80 };

async function scenario(name, assets, options = {}) {
  hits.clear();
  const started = performance.now();
  let verdict;
  try {
    const result = await loadAll(
      {
        assets: assets.map((a) => ({ ...a, type: 'json', url: base + a.url })),
      },
      { retry, ...options },
    );
    verdict = `ок, failed=${result.failed.length}`;
  } catch (error) {
    verdict = `${error.name}: ${error.message}`;
  }
  const requests = [...hits].map(([u, n]) => `${u}×${n}`).join(' ');
  const ms = (performance.now() - started).toFixed(0);
  console.log(
    `— ${name}\n   результат: ${verdict}\n   запити: ${requests}  (${ms} мс)`,
  );
}

await scenario('404: не ретраїмо', [{ key: 'a', url: '/missing.json' }]);
await scenario('404 на optional: гра живе далі', [
  { key: 'a', url: '/ok.json' },
  { key: 'b', url: '/missing.json', optional: true },
]);
await scenario('битий JSON: не ретраїмо', [{ key: 'a', url: '/broken.json' }]);
await scenario('503, 503, ок: ретраї з backoff', [
  { key: 'a', url: '/flaky.json' },
]);
await scenario(
  'таймаут: сервер мовчить, 3 спроби по 150 мс',
  [{ key: 'a', url: '/hang.json' }],
  { timeoutMs: 150 },
);
const controller = new AbortController();
setTimeout(() => controller.abort(), 100);
await scenario(
  'abort посеред завантаження: одразу, без ретраїв',
  [
    { key: 'a', url: '/hang.json' },
    { key: 'b', url: '/ok.json' },
  ],
  { signal: controller.signal, timeoutMs: 5000 },
);

server.closeAllConnections?.();
server.close();
