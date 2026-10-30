// Порівняння JSON і бінарного протоколу на реальному матчі: 4 гравці, 30 Гц.
// Запуск: node shared/tools/bench-protocol.mjs  (--md друкує таблицю для README)
import { performance } from 'node:perf_hooks';
import { binaryCodec, jsonCodec } from '../src/codec/index.ts';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, TICK_RATE } from '../src/constants.ts';
import { buildSnapshot } from '../src/protocol/snapshot.ts';
import { scriptedInput } from '../src/scenario.ts';
import { Game } from '../src/sim/game.ts';

const PLAYERS = 4;
const STEPS = 1800; // 60 с гри
const game = new Game({
  width: ARENA_WIDTH,
  height: ARENA_HEIGHT,
  seed: 7,
  arena: { enemies: 2, asteroids: 8, maxHomingAsteroids: 2 },
});
game.start();
for (let slot = 0; slot < PLAYERS; slot++)
  game.addPlayer(slot, { name: `p${slot}` });

const snapshots = [];
const inputs = [];
for (let step = 1; step <= STEPS; step++) {
  for (let slot = 0; slot < PLAYERS; slot++)
    game.setInput(slot, step, scriptedInput(slot, step));
  game.step(DT);
  snapshots.push(buildSnapshot(game, []));
  inputs.push({
    seq: step,
    ...scriptedInput(0, step),
    throttle: scriptedInput(0, step).throttle,
  });
}

const enc = new TextEncoder();
const size = (frame) =>
  typeof frame === 'string' ? enc.encode(frame).length : frame.byteLength;

function measure(codec) {
  // розігрів JIT
  for (let i = 0; i < 200; i++)
    codec.decodeSnapshot(codec.encodeSnapshot(snapshots[i]));

  let bytes = 0;
  let encodeUs = 0;
  let decodeUs = 0;
  let max = 0;
  for (const snapshot of snapshots) {
    const t0 = performance.now();
    const frame = codec.encodeSnapshot(snapshot);
    const t1 = performance.now();
    codec.decodeSnapshot(frame);
    const t2 = performance.now();
    const n = size(frame);
    bytes += n;
    max = Math.max(max, n);
    encodeUs += (t1 - t0) * 1000;
    decodeUs += (t2 - t1) * 1000;
  }

  // ввід: пакет із 3 останніх вводів на кожен крок (надлишковість)
  let inputBytes = 0;
  for (let i = 3; i < inputs.length; i++)
    inputBytes += size(
      codec.encodeInputs(
        inputs.slice(i - 3, i).map((x) => ({ ...x, fire: Boolean(x.fire) })),
      ),
    );

  const n = snapshots.length;
  return {
    name: codec.name,
    avg: bytes / n,
    max,
    down: ((bytes / n) * TICK_RATE) / 1024,
    up: ((inputBytes / (inputs.length - 3)) * TICK_RATE) / 1024,
    encodeUs: encodeUs / n,
    decodeUs: decodeUs / n,
  };
}

const rows = [measure(jsonCodec), measure(binaryCodec)];
const avgEntities =
  snapshots.reduce(
    (s, x) =>
      s +
      x.ships.length +
      x.bullets.length +
      x.asteroids.length +
      x.pickups.length,
    0,
  ) / snapshots.length;

if (process.argv.includes('--md')) {
  console.log(
    '| формат | байт/знімок (сер. / макс.) | ↓ КБ/с на клієнта | ↑ КБ/с з клієнта | encode+decode, мкс |',
  );
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${r.avg.toFixed(0)} / ${r.max} | ${r.down.toFixed(2)} | ${r.up.toFixed(2)} | ${(r.encodeUs + r.decodeUs).toFixed(1)} (${r.encodeUs.toFixed(1)} + ${r.decodeUs.toFixed(1)}) |`,
    );
  }
} else {
  console.table(
    rows.map((r) => ({
      ...r,
      avg: +r.avg.toFixed(1),
      down: +r.down.toFixed(2),
      up: +r.up.toFixed(2),
      encodeUs: +r.encodeUs.toFixed(1),
      decodeUs: +r.decodeUs.toFixed(1),
    })),
  );
}
console.log(
  `\n${PLAYERS} гравці, ${TICK_RATE} Гц, ${STEPS} знімків; у середньому ${avgEntities.toFixed(1)} сутностей у знімку; Node ${process.version}`,
);
console.log(`Бінарний у ${(rows[0].avg / rows[1].avg).toFixed(1)}× менший.`);

// "Prove it" №3: знімок із рівно 8 кораблями
const eight = {
  tick: 1,
  players: [],
  bullets: [],
  asteroids: [],
  pickups: [],
  events: [],
  ships: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1,
    slot: i,
    x: 100.123456789 + i,
    y: 200.987654321 + i,
    vx: 12.5,
    vy: -3.25,
    angle: 1.2345678,
    turret: 0.5,
    hp: 100,
    cooldown: 0.1,
    shield: 0,
    rapid: 0,
    homing: 0,
  })),
};
console.log(
  `\n8 кораблів: JSON ${size(jsonCodec.encodeSnapshot(eight))} Б, DataView ${size(binaryCodec.encodeSnapshot(eight))} Б (8 × 24 + заголовки)`,
);
