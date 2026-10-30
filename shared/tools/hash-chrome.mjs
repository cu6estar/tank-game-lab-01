// Той самий сценарій у справжньому Chromium. Хеші мусять збігтися з Node
// (shared/test/determinism.test.js: GOLDEN_HASHES) біт у біт.
// Запуск: node shared/tools/hash-chrome.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import { runScenario } from '../src/scenario.ts';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const path = normalize(join(root, req.url.split('?')[0]));
    if (!path.startsWith(root)) throw new Error('out');
    const body = await readFile(path);
    res.setHeader(
      'Content-Type',
      extname(path) === '.js' ? 'text/javascript' : 'text/html',
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/blank.html`);
const inChrome = await page.evaluate(async (url) => {
  const { runScenario } = await import(url);
  const { hashes, final } = runScenario({ seed: 20260, steps: 1000 });
  return {
    hashes,
    final,
    ua: navigator.userAgent.match(/Chrome\/[\d.]+/)[0],
    hasWindow: typeof window !== 'undefined',
  };
}, `http://127.0.0.1:${port}/scenario.js`);
await browser.close();
server.close();

const inNode = runScenario({ seed: 20260, steps: 1000 });
console.log('Node    ', process.version, inNode.hashes.join(' '));
console.log('Chromium', inChrome.ua, inChrome.hashes.join(' '));
const same = JSON.stringify(inNode.hashes) === JSON.stringify(inChrome.hashes);
console.log(
  same ? 'ЗБІГАЄТЬСЯ: 1000 кроків, 2 гравці, 4 чекпоінти' : 'РОЗБІЖНІСТЬ!',
);
process.exit(same ? 0 : 1);
