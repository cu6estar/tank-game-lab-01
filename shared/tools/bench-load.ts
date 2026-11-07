/**
 * Навантаження: скільки клієнтів тримає один процес, поки крок не перевищив
 * бюджет 33.33 мс. Моделюємо CPU сервера — по 8 ботів у кімнаті (окремий Game),
 * усі кроки за один тік, арена забита астероїдами, боти безперервно стріляють
 * (найгірший випадок для перевірки колізій "всі з усіма").
 *
 *   node shared/tools/bench-load.ts [--ticks=300] [--clients=8,32,64,128]
 */
import { performance } from 'node:perf_hooks';
import { DT } from '../src/constants.ts';
import { scriptedInput } from '../src/scenario.ts';
import { toSeq } from '../src/brand.ts';
import { Game } from '../src/sim/game.ts';

const BUDGET_MS = 1000 * DT; // 33.33 мс при 30 Гц
const PER_ROOM = 8;
const HEAVY_ARENA = { asteroids: 20, maxHomingAsteroids: 6, enemies: 6 };

function makeRooms(clients: number, seed: number): Game[] {
  const rooms: Game[] = [];
  for (let r = 0; r * PER_ROOM < clients; r++) {
    const game = new Game({ width: 1280, height: 720, seed: seed + r, arena: HEAVY_ARENA });
    game.start();
    const inRoom = Math.min(PER_ROOM, clients - r * PER_ROOM);
    for (let slot = 0; slot < inRoom; slot++) game.addPlayer(slot, { name: `b${r}.${slot}` });
    rooms.push(game);
  }
  return rooms;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

function runLevel(clients: number, ticks: number): Record<string, number | string> {
  const rooms = makeRooms(clients, 1000);
  const tickMs: number[] = [];

  for (let tick = 1; tick <= ticks; tick++) {
    const t0 = performance.now();
    for (let r = 0; r < rooms.length; r++) {
      const game = rooms[r];
      if (!game) continue;
      for (const [slot] of game.players) {
        // боти постійно стріляють: throttle=1, fire=true — максимум куль/колізій
        game.setInput(slot, toSeq(tick), { ...scriptedInput(slot, tick), throttle: 1, fire: true });
      }
      game.step(DT);
    }
    if (tick > 30) tickMs.push(performance.now() - t0); // прогрів 30 тіків
  }

  tickMs.sort((a, b) => a - b);
  const p99 = percentile(tickMs, 99);
  return {
    clients,
    rooms: rooms.length,
    'tick p50 (ms)': +percentile(tickMs, 50).toFixed(3),
    'tick p95 (ms)': +percentile(tickMs, 95).toFixed(3),
    'tick p99 (ms)': +p99.toFixed(3),
    'tick max (ms)': +(tickMs[tickMs.length - 1] ?? 0).toFixed(3),
    'over budget?': p99 > BUDGET_MS ? `ТАК (>${BUDGET_MS.toFixed(1)})` : 'ні',
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const ticksArg = argv.find((a) => a.startsWith('--ticks='));
  const clientsArg = argv.find((a) => a.startsWith('--clients='));
  const ticks = ticksArg ? Number(ticksArg.slice(8)) : 300;
  const levels = clientsArg ? clientsArg.slice(10).split(',').map(Number) : [8, 32, 64, 128];

  const rows = levels.map((n) => runLevel(n, ticks));
  console.table(rows);
  console.log(`бюджет кроку = ${BUDGET_MS.toFixed(2)} мс/тік (30 Гц)`);
}

main();
