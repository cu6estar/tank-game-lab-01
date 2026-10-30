import test from 'node:test';
import assert from 'node:assert/strict';
import { toEntityId, toSeq, toTick } from '../src/brand.ts';
import {
  binaryCodec,
  jsonCodec,
  getCodec,
  isCodecName,
  CodecError,
  peekType,
} from '../src/codec/index.ts';
import { runScenario } from '../src/scenario.ts';
import { buildSnapshot } from '../src/protocol/snapshot.ts';
import type { ClientInput, Snapshot, SnapshotShip } from '../src/protocol/types.ts';
import { wrapAngle } from '../src/sim/vector.ts';
import { MSG, BINARY_VERSION } from '../src/protocol/constants.ts';

const near = (a: number, b: number, tol: number, what: string): void =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);
// кути на дроті нормалізовані до (−π, π], тому порівнюємо за модулем 2π
const nearAngle = (a: number, b: number, tol: number, what: string): void =>
  near(wrapAngle(a - b), 0, tol, what);

function sample(): Snapshot {
  const { game } = runScenario({ steps: 150, players: 4 });
  return buildSnapshot(game, [{ type: 1, a: 2, b: 0, x: 10.5, y: 20.25 }]);
}

function emptySnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    tick: toTick(0),
    players: [],
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
    events: [],
    ...over,
  };
}

function shipState(over: Partial<SnapshotShip> = {}): SnapshotShip {
  return {
    id: toEntityId(1),
    slot: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    turret: 0,
    hp: 1,
    cooldown: 0,
    shield: 0,
    rapid: 0,
    homing: 0,
    ...over,
  };
}

const inp = (seq: number, over: Partial<Omit<ClientInput, 'seq'>> = {}): ClientInput => ({
  seq: toSeq(seq),
  throttle: 0,
  turn: 0,
  turretTurn: 0,
  fire: false,
  ...over,
});

test('snapshot: binary round trip within quantization tolerance', () => {
  const s = sample();
  const back = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(s));
  assert.equal(back.tick, s.tick);
  assert.deepEqual(back.players, s.players);
  assert.equal(back.ships.length, s.ships.length);
  assert.equal(back.bullets.length, s.bullets.length);
  assert.equal(back.asteroids.length, s.asteroids.length);
  s.ships.forEach((a, i) => {
    const b = back.ships[i];
    assert(b);
    assert.equal(b.id, a.id);
    assert.equal(b.slot, a.slot);
    assert.equal(b.hp, a.hp);
    near(b.x, a.x, 1e-3, 'x');
    near(b.y, a.y, 1e-3, 'y');
    near(b.vx, a.vx, 1 / 16, 'vx');
    nearAngle(b.angle, a.angle, 1e-4, 'angle');
    nearAngle(b.turret, a.turret, 1e-4, 'turret');
    near(b.cooldown, a.cooldown, 1 / 400 + 1e-9, 'cooldown');
  });
  s.bullets.forEach((a, i) => {
    const b = back.bullets[i];
    assert(b);
    assert.equal(b.tag, a.tag);
    assert.equal(b.homing, a.homing);
  });
  assert.deepEqual(back.events, [{ type: 1, a: 2, b: 0, x: 10.5, y: 20.25 }]);
});

test('snapshot: JSON round trip is exact', () => {
  const s = sample();
  assert.deepEqual(jsonCodec.decodeSnapshot(jsonCodec.encodeSnapshot(s)), s);
});

test('snapshot: empty world', () => {
  const s = emptySnapshot();
  assert.deepEqual(binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(s)), s);
});

test('snapshot: binary is much smaller than JSON', () => {
  const s = sample();
  const bin = binaryCodec.encodeSnapshot(s).byteLength;
  const json = new TextEncoder().encode(jsonCodec.encodeSnapshot(s)).byteLength;
  assert.ok(bin * 4 < json, `${bin} vs ${json}`);
});

test('format: version byte, type byte and little-endian tick', () => {
  const b = binaryCodec.encodeSnapshot(emptySnapshot({ tick: toTick(0x01020304) }));
  assert.equal(b[0], BINARY_VERSION);
  assert.equal(b[1], MSG.SNAPSHOT);
  assert.deepEqual([...b.slice(2, 6)], [4, 3, 2, 1]);
  assert.equal(peekType(b), MSG.SNAPSHOT);
});

test('angle: Int16 precision is better than 1e-4 rad over the whole circle', () => {
  const mk = (angle: number): Snapshot => emptySnapshot({ ships: [shipState({ angle })] });
  for (let a = -3.14; a <= 3.14; a += 0.0137) {
    const ship = binaryCodec.decodeSnapshot(binaryCodec.encodeSnapshot(mk(a))).ships[0];
    assert(ship);
    near(ship.angle, a, 1e-4, 'angle');
  }
});

test('snapshot: truncated or padded frames are rejected, never read out of bounds', () => {
  const b = binaryCodec.encodeSnapshot(sample());
  for (const n of [0, 1, 2, 5, 6, 20, b.length - 1]) {
    assert.throws(() => binaryCodec.decodeSnapshot(b.slice(0, n)), CodecError, `len ${n}`);
  }
  const padded = new Uint8Array(b.length + 1);
  padded.set(b);
  assert.throws(() => binaryCodec.decodeSnapshot(padded), CodecError);
});

test('snapshot: wrong version / type rejected', () => {
  const b = binaryCodec.encodeSnapshot(sample()).slice();
  b[0] = 99;
  assert.throws(() => binaryCodec.decodeSnapshot(b), /версі/);
  b[0] = BINARY_VERSION;
  b[1] = MSG.INPUT;
  assert.throws(() => binaryCodec.decodeSnapshot(b), CodecError);
});

const inputs: ClientInput[] = [
  inp(1, { throttle: 1, turn: -1, turretTurn: 0, fire: true }),
  inp(0xfffffffe, { throttle: 0, turn: 1, turretTurn: -1, fire: false }),
];

for (const codec of [binaryCodec, jsonCodec]) {
  test(`inputs (${codec.name}): round trip`, () => {
    assert.deepEqual(codec.decodeInputs(codec.encodeInputs(inputs)), inputs);
  });
}

test('inputs: binary packet is 3 + 8·n bytes', () => {
  assert.equal(binaryCodec.encodeInputs(inputs).byteLength, 3 + 8 * 2);
});

test('inputs: garbage is rejected (both codecs)', () => {
  // Негативні дані навмисно порушують тип ClientInput, тому їх кодуємо вручну
  // як JSON, а не через типізований encodeInputs.
  const badInputs: unknown[] = [
    { seq: 1, throttle: 5, turn: 0, turretTurn: 0, fire: true },
    { seq: 1, throttle: 0.5, turn: 0, turretTurn: 0, fire: true },
    { seq: 1, throttle: 0, turn: 0, turretTurn: 0, fire: 1 },
    { seq: -1, throttle: 0, turn: 0, turretTurn: 0, fire: true },
    { seq: NaN, throttle: 0, turn: 0, turretTurn: 0, fire: true },
  ];
  for (const bad of badInputs) {
    assert.throws(() => jsonCodec.decodeInputs(JSON.stringify({ type: 'input', inputs: [bad] })), CodecError);
  }
  const frame = binaryCodec.encodeInputs([inp(1)]).slice();
  frame[3 + 4] = 5; // throttle = 5
  assert.throws(() => binaryCodec.decodeInputs(frame), CodecError);
  const flags = binaryCodec.encodeInputs([inp(1)]).slice();
  flags[3 + 7] = 0xff;
  assert.throws(() => binaryCodec.decodeInputs(flags), CodecError);
  assert.throws(() => binaryCodec.decodeInputs(binaryCodec.encodeInputs([inp(1)]).slice(0, 8)), CodecError);
  assert.throws(() => jsonCodec.decodeInputs('{nope'), CodecError);
  assert.throws(() => jsonCodec.decodeInputs(JSON.stringify({ type: 'input', inputs: [] })), CodecError);
});

test('inputs: too many per packet rejected', () => {
  const many = Array.from({ length: 9 }, (_, i) => inp(i));
  const frame = binaryCodec.encodeInputs(many);
  assert.throws(() => binaryCodec.decodeInputs(frame), CodecError);
});

test('ping / pong round trip', () => {
  assert.equal(binaryCodec.decodePing(binaryCodec.encodePing(123456)), 123456);
  assert.deepEqual(binaryCodec.decodePong(binaryCodec.encodePong(7, 99)), { echo: 7, tick: 99 });
  assert.equal(jsonCodec.decodePing(jsonCodec.encodePing(5)), 5);
  assert.deepEqual(jsonCodec.decodePong(jsonCodec.encodePong(7, 99)), { echo: 7, tick: 99 });
});

test('getCodec / isCodecName: unknown name is rejected', () => {
  assert.equal(getCodec('binary'), binaryCodec);
  assert.equal(isCodecName('binary'), true);
  assert.equal(isCodecName('xml'), false);
});

test('fuzz: random bytes never throw anything but CodecError', () => {
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8) & 0xff;
  for (let i = 0; i < 2000; i++) {
    const frame = Uint8Array.from({ length: rnd() % 60 }, rnd);
    if (frame.length > 1 && i % 2) {
      frame[0] = BINARY_VERSION;
      frame[1] = i % 4 ? MSG.SNAPSHOT : MSG.INPUT;
    }
    for (const fn of [binaryCodec.decodeSnapshot, binaryCodec.decodeInputs]) {
      try {
        fn(frame);
      } catch (e: unknown) {
        assert.ok(e instanceof CodecError, String(e));
      }
    }
  }
});
