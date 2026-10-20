// Експеримент: ті самі Math.sin/cos/pow у Node і в Chromium дають РІЗНІ біти (специфікація це дозволяє).
// Через це симуляція не використовує Math.sin/cos/atan2/pow/exp (див. shared/src/math.js).
// Запуск: node shared/experiments/math-divergence.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
const root = fileURLToPath(new URL('../src/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, req.url.split('?')[0]));
    res.setHeader(
      'Content-Type',
      extname(p) === '.js' ? 'text/javascript' : 'text/html',
    );
    res.end(await readFile(p));
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
// 1. математичні функції: однакові входи → біти результату
const inputs = [
  0.1,
  0.5,
  1,
  1.5,
  2,
  2.5,
  3,
  0.7853981633974483,
  1.2345,
  100.5,
  -0.3,
  12.9,
  0.88,
  0.88 ** 2,
];
const code = `(${function (inputs) {
  const dv = new DataView(new ArrayBuffer(8));
  const bits = (x) => {
    dv.setFloat64(0, x, true);
    return dv.getBigUint64(0, true).toString(16);
  };
  const out = {};
  for (const [name, f] of Object.entries({
    sin: Math.sin,
    cos: Math.cos,
    atan2: (x) => Math.atan2(x, 1.3),
    hypot: (x) => Math.hypot(x, 2.1),
    pow: (x) => Math.pow(0.88, x * 2),
    exp: (x) => Math.exp((-3 * x) / 30),
    sqrt: Math.sqrt,
    atan: Math.atan,
  }))
    out[name] = inputs.map((x) => bits(f(x)));
  return out;
}.toString()})`;
const chrome = await page.evaluate(`(${code})(${JSON.stringify(inputs)})`);
const node = eval(code)(inputs);
for (const k of Object.keys(node)) {
  const diff = node[k]
    .map((v, i) => (v === chrome[k][i] ? null : i))
    .filter((i) => i !== null);
  console.log(
    k.padEnd(6),
    diff.length
      ? 'РІЗНІ на входах ' + diff.map((i) => inputs[i]).join(', ')
      : 'однакові',
  );
}
await browser.close();
server.close();
