import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';

import { toEntityId, toSeq, toTick } from '../src/brand.ts';
import { ARENA_HEIGHT, ARENA_WIDTH, DT } from '../src/constants.ts';
import { binaryCodec, CodecError, jsonCodec } from '../src/codec/index.ts';
import { MAX_INPUTS_PER_PACKET } from '../src/protocol/constants.ts';
import type { ClientInput, Snapshot, SnapshotShip } from '../src/protocol/types.ts';
import { Game } from '../src/sim/game.ts';
import { wrapAngle } from '../src/sim/vector.ts';

// Властивісні тести (fast-check): замість кількох прикладів — сотні випадкових
// входів під один закон. Кожен тест формулює інваріант, а не окремий випадок.

const RUNS = { numRuns: 300 };

// ------------------------------------------------------------- генератори

const axis = fc.constantFrom<-1 | 0 | 1>(-1, 0, 1);

// fast-check уміє згенерувати -0; JSON нормалізує його в 0, а deepStrictEqual
// їх розрізняє — тож прибираємо -0 на вході, щоб закон залишався про кодек.
const dbl = (opts: { min: number; max: number }): fc.Arbitrary<number> =>
  fc.double({ ...opts, noNaN: true }).map((v) => (v === 0 ? 0 : v));

const inputArb: fc.Arbitrary<ClientInput> = fc.record({
  seq: fc.integer({ min: 0, max: 0xfffffffe }).map(toSeq),
  throttle: axis,
  turn: axis,
  turretTurn: axis,
  fire: fc.boolean(),
});

const shipArb: fc.Arbitrary<SnapshotShip> = fc.record({
  id: fc.integer({ min: 1, max: 0xffff }).map(toEntityId),
  slot: fc.integer({ min: 0, max: 7 }),
  x: dbl({ min: 0, max: ARENA_WIDTH }),
  y: dbl({ min: 0, max: ARENA_HEIGHT }),
  // швидкість кодується Int16 у 1/8 px/с (±4095) — тримаємось у діапазоні
  vx: dbl({ min: -4000, max: 4000 }),
  vy: dbl({ min: -4000, max: 4000 }),
  angle: dbl({ min: -Math.PI, max: Math.PI }),
  turret: dbl({ min: -Math.PI, max: Math.PI }),
  hp: fc.integer({ min: 0, max: 100 }),
  cooldown: fc.constant(0),
  shield: fc.constant(0),
  rapid: fc.constant(0),
  homing: fc.constant(0),
});

const snapshotOfShips = (ships: SnapshotShip[]): Snapshot => ({
  tick: toTick(0),
  players: [],
  ships,
  bullets: [],
  asteroids: [],
  pickups: [],
  events: [],
});

// --------------------------------------------------------------- закони

// 1) Декодування повертає те саме повідомлення — з поправкою на квантування
//    позицій (Float32), швидкості (Int16, крок 0.125) і кута (Int16, ≈1e-4).
test('property: бінарний знімок переживає round trip у межах квантування', () => {
  fc.assert(
    fc.property(fc.array(shipArb, { maxLength: 8 }), (ships) => {
      const decoded = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(snapshotOfShips(ships)));
      assert.equal(decoded.ships.length, ships.length);
      decoded.ships.forEach((got, i) => {
        const want = ships[i];
        assert(want);
        assert.equal(got.id, want.id);
        assert.equal(got.slot, want.slot);
        assert.equal(got.hp, want.hp);
        assert.ok(Math.abs(got.x - want.x) <= 1e-2, `x: ${got.x} vs ${want.x}`);
        assert.ok(Math.abs(got.y - want.y) <= 1e-2, `y: ${got.y} vs ${want.y}`);
        assert.ok(Math.abs(got.vx - want.vx) <= 0.07, `vx: ${got.vx} vs ${want.vx}`);
        assert.ok(Math.abs(got.vy - want.vy) <= 0.07, `vy: ${got.vy} vs ${want.vy}`);
        assert.ok(Math.abs(wrapAngle(got.angle - want.angle)) <= 2e-4, `angle`);
        assert.ok(Math.abs(wrapAngle(got.turret - want.turret)) <= 2e-4, `turret`);
      });
    }),
    RUNS,
  );
});

// JSON-кодек точний (без квантування) — той самий об'єкт назад.
test('property: JSON-знімок round trip точний', () => {
  fc.assert(
    fc.property(fc.array(shipArb, { maxLength: 8 }), (ships) => {
      const s = snapshotOfShips(ships);
      assert.deepEqual(jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(s)), s);
    }),
    RUNS,
  );
});

// 2) Довжина кадру збігається з описом формату: бінарний пакет вводу — рівно
//    3 + 8·n байтів (заголовок 3 + по 8 на кожен ввід).
test('property: довжина пакета вводу = 3 + 8·n', () => {
  fc.assert(
    fc.property(fc.array(inputArb, { minLength: 1, maxLength: MAX_INPUTS_PER_PACKET }), (inputs) => {
      assert.equal(binaryCodec.encodeInputs(inputs).byteLength, 3 + 8 * inputs.length);
    }),
    RUNS,
  );
});

// 3) Будь-який зіпсований буфер дає CodecError — не TypeError, не RangeError,
//    не падіння процесу. Декодер завжди сам перевіряє довжину/діапазони.
test('property: сміттєві байти кидають лише CodecError (ніколи не падають)', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 80 }), (bytes) => {
      for (const decode of [
        () => binaryCodec.decodeSnapshot(bytes),
        () => binaryCodec.decodeInputs(bytes),
      ]) {
        try {
          decode();
        } catch (error) {
          assert.ok(error instanceof CodecError, `несподівана помилка: ${String(error)}`);
        }
      }
    }),
    RUNS,
  );
});

// 4) Корабель завжди лишається в межах арени: світ тороїдальний, тож після
//    будь-якої послідовності вводів координати нормалізовані у [0, розмір).
test('property: корабель не вилітає за межі арени за будь-яких вводів', () => {
  fc.assert(
    fc.property(fc.array(fc.record({ throttle: axis, turn: axis, fire: fc.boolean() }), { minLength: 1, maxLength: 120 }), (plan) => {
      const game = new Game({ width: ARENA_WIDTH, height: ARENA_HEIGHT, seed: 42 });
      game.start();
      game.addPlayer(0, { name: 'prop' });
      plan.forEach((intent, i) => {
        game.setInput(0, toSeq(i + 1), { ...intent, turretTurn: 0 });
        game.step(DT);
        const ship = game.shipOf(0);
        if (ship) {
          assert.ok(ship.pos.x >= 0 && ship.pos.x < ARENA_WIDTH, `x поза ареною: ${ship.pos.x}`);
          assert.ok(ship.pos.y >= 0 && ship.pos.y < ARENA_HEIGHT, `y поза ареною: ${ship.pos.y}`);
        }
      });
    }),
    { numRuns: 80 },
  );
});
