/**
 * Профіль симуляції: 8 ботів, 30 с (1800 кроків 30 Гц) в одному процесі.
 * Міряє час кроку (p50/p95/p99), паузи збирання сміття і фінальний хеш
 * (щоб довести: оптимізації не змінили поведінку — хеш той самий).
 *
 *   node shared/tools/bench-sim.ts [--steps=1800] [--players=8] [--seed=20260]
 *
 * Для детальної картинки алокацій знімайте flame chart у Chrome DevTools:
 *   node --cpu-prof --cpu-prof-dir=prof shared/tools/bench-sim.ts
 */
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { DT } from '../src/constants.ts';
import { hashGame } from '../src/hash.ts';
import { scriptedInput } from '../src/scenario.ts';
import { toSeq } from '../src/brand.ts';
import { Game } from '../src/sim/game.ts';

interface Args {
  steps: number;
  players: number;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? Number(hit.slice(name.length + 3)) : fallback;
  };
  return { steps: get('steps', 1800), players: get('players', 8), seed: get('seed', 20260) };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function main(): void {
  const { steps, players, seed } = parseArgs(process.argv.slice(2));

  const gc = { count: 0, total: 0, max: 0 };
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count += 1;
      gc.total += entry.duration;
      gc.max = Math.max(gc.max, entry.duration);
    }
  });
  observer.observe({ entryTypes: ['gc'] });

  const game = new Game({ width: 1280, height: 720, seed });
  game.start();
  for (let slot = 0; slot < players; slot++) game.addPlayer(slot, { name: `bot${slot}` });

  const stepMs: number[] = [];
  // прогрів JIT — перші кроки не рахуємо (щоб p99 не ловив деоптимізацію старту)
  const warmup = 60;

  for (let step = 1; step <= steps + warmup; step++) {
    for (let slot = 0; slot < players; slot++) {
      game.setInput(slot, toSeq(step), scriptedInput(slot, step));
    }
    const t0 = performance.now();
    game.step(DT);
    const dt = performance.now() - t0;
    if (step > warmup) stepMs.push(dt);
  }

  observer.disconnect();
  stepMs.sort((a, b) => a - b);

  const sum = stepMs.reduce((a, b) => a + b, 0);
  const mem = process.memoryUsage();
  const row = {
    players,
    steps,
    'step avg (ms)': +(sum / stepMs.length).toFixed(4),
    'step p50 (ms)': +percentile(stepMs, 50).toFixed(4),
    'step p95 (ms)': +percentile(stepMs, 95).toFixed(4),
    'step p99 (ms)': +percentile(stepMs, 99).toFixed(4),
    'step max (ms)': +(stepMs[stepMs.length - 1] ?? 0).toFixed(4),
    'GC count': gc.count,
    'GC total (ms)': +gc.total.toFixed(2),
    'GC max pause (ms)': +gc.max.toFixed(2),
    'heapUsed (MB)': +(mem.heapUsed / 1048576).toFixed(1),
  };

  console.table([row]);
  console.log('budget 30 Гц = 33.33 ms/крок; ціль p99 < 16.7 ms');
  console.log('final hash:', hashGame(game));
}

main();
