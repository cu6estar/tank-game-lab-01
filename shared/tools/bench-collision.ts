/**
 * Мікробенч колізій: наївний O(n²) проти просторової сітки на зростанні N.
 * Також доводить рівність — обидва дають однаковий список пар (інакше хеш
 * стану розійшовся б). Саме тут сітка виграє асимптотично; у реальній грі
 * сутностей десятки, тому там різниця мізерна (див. bench-load).
 *
 *   node shared/tools/bench-collision.ts [--sizes=50,100,200,400,800,1600]
 */
import { performance } from 'node:perf_hooks';
import { createRng } from '../src/rng.ts';
import { Asteroid } from '../src/sim/asteroid.ts';
import { findCollisions, findCollisionsNaive } from '../src/sim/collision.ts';
import type { SimEntity } from '../src/sim/entities.ts';
import { Vector2 } from '../src/sim/vector.ts';

const FIELD = 1280; // щільність зберігаємо, збільшуючи лише кількість

function field(n: number, seed = 7): SimEntity[] {
  const rand = createRng(seed);
  const span = FIELD * Math.sqrt(n / 60); // ~стала щільність: площа росте з n
  return Array.from({ length: n }, () => {
    const radius = 20 + rand() * 26;
    const pos = new Vector2(rand() * span, rand() * span);
    return new Asteroid({ pos, vel: new Vector2(), radius });
  });
}

function samePairs(a: [SimEntity, SimEntity][], b: [SimEntity, SimEntity][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const pa = a[i];
    const pb = b[i];
    if (!pa || !pb || pa[0] !== pb[0] || pa[1] !== pb[1]) return false;
  }
  return true;
}

function timeIt(fn: () => unknown, iters: number): number {
  for (let i = 0; i < 20; i++) fn(); // прогрів
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

function main(): void {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--sizes='));
  const sizes = arg ? arg.slice(8).split(',').map(Number) : [50, 100, 200, 400, 800, 1600];

  const rows = sizes.map((n) => {
    const entities = field(n);
    const iters = Math.max(20, Math.round(20000 / n));
    const naive = timeIt(() => findCollisionsNaive(entities), iters);
    const grid = timeIt(() => findCollisions(entities), iters);
    const equal = samePairs(findCollisionsNaive(entities), findCollisions(entities));
    return {
      N: n,
      pairs: findCollisions(entities).length,
      'naive O(n²) (ms)': +naive.toFixed(4),
      'grid (ms)': +grid.toFixed(4),
      speedup: +(naive / grid).toFixed(2),
      'pairs identical': equal ? 'так' : 'НІ — розбіжність!',
    };
  });

  console.table(rows);
}

main();
