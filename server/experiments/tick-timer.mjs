// "Prove it" №4: setInterval(33) проти setTimeout з абсолютною ціллю, 5 секунд.
// Запуск: node server/experiments/tick-timer.mjs [--busy]   (--busy: кожен тік "працює" 5–25 мс)
import { performance } from 'node:perf_hooks';

const STEP = 1000 / 30;
const DURATION = 5000;
const busy = process.argv.includes('--busy');

const work = () => {
  if (!busy) return;
  const end = performance.now() + 5 + Math.random() * 20;
  while (performance.now() < end);
};

function summarize(name, times) {
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(
    gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length,
  );
  const expectedTicks = Math.floor(DURATION / STEP);
  const drift = times.at(-1) - times[0] - (times.length - 1) * STEP;
  console.log(
    `${name.padEnd(22)} тіків: ${String(times.length).padStart(3)} (ідеал ${expectedTicks})  ` +
      `інтервал: ${mean.toFixed(2)} ± ${sd.toFixed(2)} мс (мін ${Math.min(...gaps).toFixed(1)}, макс ${Math.max(...gaps).toFixed(1)})  ` +
      `дрейф за 5 с: ${drift.toFixed(0)} мс`,
  );
}

function runInterval() {
  return new Promise((resolve) => {
    const times = [];
    const start = performance.now();
    const id = setInterval(() => {
      times.push(performance.now());
      work();
      if (performance.now() - start >= DURATION) {
        clearInterval(id);
        resolve(times);
      }
    }, 33); // 33, бо 33.33 setInterval округлює
  });
}

function runAbsolute() {
  return new Promise((resolve) => {
    const times = [];
    const start = performance.now();
    let n = 0;
    (function schedule() {
      const target = start + (n + 1) * STEP; // АБСОЛЮТНА ціль: похибка не накопичується
      setTimeout(
        () => {
          times.push(performance.now());
          work();
          n += 1;
          if (performance.now() - start >= DURATION) return resolve(times);
          schedule();
        },
        Math.max(0, target - performance.now()),
      );
    })();
  });
}

console.log(`Node ${process.version}${busy ? ', з навантаженням у тіку' : ''}`);
summarize('setInterval(33)', await runInterval());
summarize('setTimeout до цілі', await runAbsolute());
