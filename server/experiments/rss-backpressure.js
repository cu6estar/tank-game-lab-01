// Доказ backpressure: 200 МБ логу качаємо ПОВІЛЬНО і міряємо rss сервера.
//   pipeline — наш справжній сервер (GET /api/replays/:id, pipeline(readStream, res))
//   naive    — контрприклад: res.write() у циклі подій без перевірки значення
// Запуск: node experiments/rss-backpressure.js [--mb=200] [--rate=10] [--out=../docs/rss]
//   --rate — швидкість "повільного каналу", МБ/с (клієнт читає не швидше)
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { makeBigLog } from '../tools/make-big-log.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')),
);
const MB = Number(args.mb ?? 200);
const RATE = Number(args.rate ?? 10) * 1024 * 1024; // байт/с
const OUT = resolve(args.out ?? '../docs/rss');
const LOG_DIR = resolve(args.logdir ?? '../logs-experiment');
const ID = `synthetic-${MB}mb`;
const FILE = join(LOG_DIR, `${ID}.ndjson`);

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const rssOf = (port) =>
  new Promise((res) => {
    http
      .get({ host: '127.0.0.1', port, path: '/health', agent: false }, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => res(JSON.parse(body).rss));
      })
      .on('error', () => res(null));
  });

function spawnServer(cmdArgs, env = {}) {
  const child = spawn(process.execPath, cmdArgs, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((res) =>
    child.stdout.on('data', (d) => /ready|http:\/\//.test(d) && res(child)),
  );
}

/** Клієнт "повільного каналу": бере шматок і чекає стільки, скільки він зайняв би за RATE. */
function slowDownload(port, path, onBytes) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          onBytes(total);
          res.pause();
          setTimeout(() => res.resume(), (chunk.length / RATE) * 1000);
        });
        res.on('end', () => resolve(total));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function run(mode) {
  const port = await freePort();
  const child =
    mode === 'pipeline'
      ? await spawnServer(['src/index.js'], {
          PORT: String(port),
          LOG_DIR,
          HOST: '127.0.0.1',
        })
      : await spawnServer(['experiments/naive-server.js', FILE, String(port)]);

  const samples = [];
  const t0 = performance.now();
  let received = 0;
  const baseline = await rssOf(port);

  const sampler = setInterval(async () => {
    const rss = await rssOf(port);
    if (rss) {
      samples.push({
        t: (performance.now() - t0) / 1000,
        rssMb: rss / 1024 / 1024,
        receivedMb: received / 1024 / 1024,
      });
    }
  }, 250);

  const path = mode === 'pipeline' ? `/api/replays/${ID}` : '/anything';
  const total = await slowDownload(port, path, (n) => (received = n));
  clearInterval(sampler);
  const seconds = (performance.now() - t0) / 1000;
  child.kill('SIGTERM');

  const peak = Math.max(...samples.map((s) => s.rssMb));
  console.log(
    `${mode.padEnd(8)} скачано ${(total / 1048576).toFixed(0)} МБ за ${seconds.toFixed(1)} с · ` +
      `rss: старт ${(baseline / 1048576).toFixed(0)} МБ, пік ${peak.toFixed(0)} МБ, ` +
      `приріст ${(peak - baseline / 1048576).toFixed(0)} МБ`,
  );

  mkdirSync(resolve(OUT, '..'), { recursive: true });
  writeFileSync(
    `${OUT}-${mode}.csv`,
    'seconds,rss_mb,received_mb\n' +
      samples
        .map(
          (s) =>
            `${s.t.toFixed(2)},${s.rssMb.toFixed(1)},${s.receivedMb.toFixed(1)}`,
        )
        .join('\n') +
      '\n',
  );
  return { baseline: baseline / 1048576, peak, seconds };
}

try {
  statSync(FILE);
} catch {
  console.log(`генерую ${MB} МБ логу → ${FILE}`);
  await makeBigLog(FILE, MB);
}
console.log(
  `канал: ${RATE / 1048576} МБ/с, файл: ${(statSync(FILE).size / 1048576).toFixed(0)} МБ`,
);

const result = {};
for (const mode of (args.modes ?? 'pipeline,naive').split(','))
  result[mode] = await run(mode);
writeFileSync(`${OUT}-summary.json`, JSON.stringify(result, null, 2));
