// Вибір затримки інтерполяції: симулюємо мережу з jitter і втратами та рахуємо,
// скільки кадрів клієнт "голодує" (потрібного знімка ще немає) при різних delay.
// Запуск: node client/tools/measure-delay.mjs [--md]
import { TICK_MS } from '@tank/shared/constants.ts';
import { createRng } from '@tank/shared/rng.ts';
import { SnapshotBuffer } from '../src/net/snapshot-buffer.ts';

const SIM_MS = 60_000;
const WARMUP_MS = 3_000;
const FRAME_MS = 1000 / 60;
const BASE_ONE_WAY = 50; // мс (RTT ≈ 100)

function simulate({ jitter, drop, delay, seed = 42 }) {
  const rand = createRng(seed);
  const arrivals = [];
  let previous = 0;
  for (let tick = 1; tick * TICK_MS < SIM_MS; tick++) {
    if (rand() * 100 < drop) continue;
    // порядок зберігається (як в інжекторі й у TCP): пакет не обганяє попередній
    const arrival = Math.max(
      previous,
      tick * TICK_MS + BASE_ONE_WAY + (rand() * 2 - 1) * jitter,
    );
    previous = arrival;
    arrivals.push({ tick, arrival });
  }

  const buffer = new SnapshotBuffer();
  let next = 0;
  let frames = 0;
  let starved = 0;
  let gap = 0;
  for (let t = WARMUP_MS; t < SIM_MS - 1000; t += FRAME_MS) {
    while (next < arrivals.length && arrivals[next].arrival <= t) {
      const { tick, arrival } = arrivals[next++];
      buffer.push(
        {
          tick,
          players: [],
          ships: [],
          bullets: [],
          asteroids: [],
          pickups: [],
          events: [],
        },
        arrival,
      );
    }
    const server = buffer.serverTime(t);
    if (server === null) continue;
    const sample = buffer.sample(server - delay);
    if (!sample) continue;
    frames += 1;
    if (sample.starved) starved += 1;
    else if (sample.b.tick - sample.a.tick > 1) gap += 1;
  }
  return { starved: (starved / frames) * 100, gap: (gap / frames) * 100 };
}

const scenarios = [
  { name: 'ідеальна мережа', jitter: 0, drop: 0 },
  { name: 'jitter ±30 мс', jitter: 30, drop: 0 },
  { name: 'jitter ±30 мс, втрати 2%', jitter: 30, drop: 2 },
  { name: 'jitter ±60 мс, втрати 5%', jitter: 60, drop: 5 },
];
const delays = [0, 33, 66, 100, 133, 166, 200];

const md = process.argv.includes('--md');
const pad = (s, n) => String(s).padEnd(n);
if (md) {
  console.log(`| сценарій | ${delays.map((d) => `${d} мс`).join(' | ')} |`);
  console.log(`|---|${delays.map(() => '---').join('|')}|`);
} else {
  console.log(
    pad('сценарій', 28) + delays.map((d) => pad(`${d} мс`, 14)).join(''),
  );
}
for (const s of scenarios) {
  const cells = delays.map((delay) => {
    const r = simulate({ ...s, delay });
    return `${r.starved.toFixed(1)}% / ${r.gap.toFixed(1)}%`;
  });
  console.log(
    md
      ? `| ${s.name} | ${cells.join(' | ')} |`
      : pad(s.name, 28) + cells.map((c) => pad(c, 14)).join(''),
  );
}
console.log(
  '\nкомірка: кадри "голоду" / кадри інтерполяції через пропущений знімок (60 с, 60 fps)',
);
