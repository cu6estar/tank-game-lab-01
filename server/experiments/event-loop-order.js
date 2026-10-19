// Фази циклу подій: де виконується nextTick, проміс, setTimeout(0), setImmediate.
//   node experiments/event-loop-order.js         — 8 запусків із головного модуля
//   node experiments/event-loop-order.js inner   — один запуск зсередини I/O-колбека
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs';

if (process.argv[2] === 'main') {
  const out = [];
  setTimeout(() => out.push('timeout'), 0);
  setImmediate(() => out.push('immediate'));
  process.nextTick(() => out.push('nextTick'));
  Promise.resolve().then(() => out.push('promise'));
  out.push('sync');
  setTimeout(() => console.log(out.join(' → ')), 20);
} else if (process.argv[2] === 'inner') {
  readFile(import.meta.filename, () => {
    const out = [];
    setTimeout(() => out.push('timeout'), 0);
    setImmediate(() => out.push('immediate'));
    process.nextTick(() => out.push('nextTick'));
    Promise.resolve().then(() => out.push('promise'));
    setTimeout(() => console.log(out.join(' → ')), 20);
  });
} else {
  const run = (mode) =>
    spawnSync(process.execPath, [import.meta.filename, mode], {
      encoding: 'utf8',
    }).stdout.trim();
  console.log(
    'з головного модуля (порядок timeout/immediate НЕ гарантований):',
  );
  const seen = new Map();
  for (let i = 0; i < 12; i++) {
    const line = run('main');
    seen.set(line, (seen.get(line) ?? 0) + 1);
  }
  for (const [line, count] of seen) console.log(`  ${count}× ${line}`);

  console.log('\nзсередини I/O-колбека (завжди однаково):');
  const inner = new Map();
  for (let i = 0; i < 12; i++) {
    const line = run('inner');
    inner.set(line, (inner.get(line) ?? 0) + 1);
  }
  for (const [line, count] of inner) console.log(`  ${count}× ${line}`);
}
