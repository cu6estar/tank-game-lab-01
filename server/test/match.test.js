import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { binaryCodec } from '@tank/shared/codec/index.js';
import { CLOSE } from '../src/protocol.js';
import { Match, MAX_QUEUE, QUEUE_TARGET } from '../src/match.js';
import { Room } from '../src/rooms.js';
import { connect, sleep, startApp } from './helpers.js';

const input = (seq, extra = {}) => ({
  seq,
  throttle: 1,
  turn: 0,
  turretTurn: 0,
  fire: false,
  ...extra,
});

/** Кімната без сокетів: гравці — об'єкти, що збирають кадри. */
function fakeRoom(codec = 'binary') {
  const room = new Room({
    id: 't',
    name: 'T',
    arena: { enemies: 0, asteroids: 0 },
  });
  const frames = [];
  const player = {
    id: 'p1',
    name: 'A',
    codec,
    send() {},
    sendFrame: (frame) => (frames.push(frame), true),
  };
  room.join(player);
  const match = new Match({
    room,
    seed: 5,
    logger: { info() {}, warn() {}, error() {} },
  });
  match.addPlayer(player);
  return { room, player, match, frames };
}

describe('Match: черга вводу', () => {
  test('дублікати й старі seq відкидаються, ack = останній виконаний', () => {
    const { match, player } = fakeRoom();
    match.receiveInputs(player, [input(1), input(2), input(3)]);
    match.receiveInputs(player, [input(2), input(3)]); // надлишковість: дублікати
    assert.equal(match.queueLength(player.slot), 3);
    match.step();
    assert.equal(match.game.players.get(player.slot).seq, 1);
    match.step();
    assert.equal(match.game.players.get(player.slot).seq, 2);
  });

  test('черга обмежена (захист від спід-хаку: 1000 вводів за раз)', () => {
    const { match, player } = fakeRoom();
    match.receiveInputs(
      player,
      Array.from({ length: 8 }, (_, i) => input(i)),
    );
    match.receiveInputs(
      player,
      Array.from({ length: 8 }, (_, i) => input(100 + i)),
    );
    assert.equal(match.queueLength(player.slot), MAX_QUEUE);
    assert.ok(match.stats().droppedInputs > 0);
  });

  test('надто довга черга скорочується: затримка керування не накопичується', () => {
    const { match, player } = fakeRoom();
    match.receiveInputs(
      player,
      Array.from({ length: 8 }, (_, i) => input(i)),
    );
    match.step();
    assert.ok(match.queueLength(player.slot) <= QUEUE_TARGET);
    assert.ok(match.stats().skippedInputs > 0);
  });

  test('порожня черга: лишається останній ввід, ack не змінюється', () => {
    const { match, player } = fakeRoom();
    match.receiveInputs(player, [input(7)]);
    match.step();
    const before =
      match.game.shipOf(player.slot).vel.x ** 2 +
      match.game.shipOf(player.slot).vel.y ** 2;
    match.step(); // черга порожня
    const after =
      match.game.shipOf(player.slot).vel.x ** 2 +
      match.game.shipOf(player.slot).vel.y ** 2;
    assert.equal(match.game.players.get(player.slot).seq, 7);
    assert.ok(after >= before, 'корабель і далі розганяється');
    assert.equal(match.stats().repeatedInputs, 1);
  });

  test('кожен крок розсилає знімок у кодеку гравця', () => {
    const { match, frames } = fakeRoom('binary');
    match.step();
    match.step();
    assert.equal(frames.length, 2);
    assert.equal(binaryCodec.decodeSnapshot(frames[1]).tick, 2);
  });
});

describe('Match: тікер з абсолютною ціллю', () => {
  test('30 Гц без накопичення дрейфу: N кроків ≈ N·33.3 мс', async () => {
    const { match } = fakeRoom();
    match.start();
    const t0 = performance.now();
    await sleep(1000);
    match.stop();
    const elapsed = performance.now() - t0;
    const expected = Math.floor(elapsed / (1000 / 30));
    assert.ok(
      Math.abs(match.tick - expected) <= 1,
      `тіків ${match.tick}, очікувалось ≈${expected}`,
    );
  });

  test('перевантажений крок: catch-up обмежений, час відпускається (resync)', async () => {
    const { match } = fakeRoom();
    let blocked = false;
    match.onTick = () => {
      if (!blocked && match.tick === 3) {
        blocked = true;
        const end = performance.now() + 200; // ~6 інтервалів
        while (performance.now() < end);
      }
    };
    match.start();
    await sleep(500);
    match.stop();
    const stats = match.stats();
    assert.equal(stats.resyncs, 1);
    assert.ok(stats.tickMs.max >= 190);
    // без resync сервер "пробіг" би 6 пропущених кроків за мить; з resync — ні
    const ticksPerSecond = match.tick / 0.5;
    assert.ok(ticksPerSecond < 35, `${ticksPerSecond}`);
  });
});

describe('Match через WebSocket', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  const lastSnapshot = (c) => binaryCodec.decodeSnapshot(c.frames.at(-1));
  const waitSnapshot = (c, predicate) =>
    c.waitFor(
      () =>
        c.frames.some(
          (f) => f[1] === 0x81 && predicate(binaryCodec.decodeSnapshot(f)),
        ),
      3000,
    );

  test('welcome містить насіння, слоти розрізняються, знімки йдуть бінарні', async () => {
    const a = connect(t.wsUrl);
    const b = connect(t.wsUrl);
    const wa = await a.join('belt', 'A', 'binary');
    const wb = await b.join('belt', 'B', 'binary');
    assert.equal(wa.v, 2);
    assert.equal(wa.match.codec, 'binary');
    assert.equal(wa.match.seed, wb.match.seed);
    assert.equal(wa.match.tickRate, 30);

    const roster = await b.waitFor(
      (m) => m.type === 'roster' && m.players.length === 2,
    );
    assert.deepEqual(
      roster.players.map((p) => p.slot),
      [0, 1],
    );

    await waitSnapshot(
      a,
      (s) => s.ships.filter((x) => x.slot !== 255).length === 2,
    );
    a.socket.close();
    b.socket.close();
  });

  test('ввід по бінарному протоколу рухає корабель, ack зростає', async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'Mover', 'binary');
    await waitSnapshot(c, (s) => s.ships.some((x) => x.slot === 0));
    const startX = lastSnapshot(c).ships.find((x) => x.slot === 0);

    for (let seq = 1; seq <= 30; seq++) {
      c.socket.send(binaryCodec.encodeInputs([input(seq)]));
      await sleep(33);
    }
    await waitSnapshot(c, (s) => s.players[0].ack >= 25);
    const end = lastSnapshot(c);
    const ship = end.ships.find((x) => x.slot === 0);
    const moved = Math.hypot(ship.x - startX.x, ship.y - startX.y);
    assert.ok(moved > 5, `корабель зрушив лише на ${moved}`);
    c.socket.close();
  });

  test('ping → pong з тіком сервера', async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'P', 'binary');
    c.socket.send(binaryCodec.encodePing(1234));
    await c.waitFor(() => c.frames.some((f) => f[1] === 0x82));
    const pong = binaryCodec.decodePong(c.frames.find((f) => f[1] === 0x82));
    assert.equal(pong.echo, 1234);
    assert.ok(pong.tick >= 0);
    c.socket.close();
  });

  test('JSON-кодек: знімки текстові, ввід JSON', async () => {
    const c = connect(t.wsUrl);
    await c.join('duel', 'J', 'json');
    await c.waitForType('snapshot');
    c.send({ type: 'input', inputs: [input(1)] });
    const snap = await c.waitFor(
      (m) => m.type === 'snapshot' && m.players[0]?.ack === 1,
    );
    assert.equal(snap.players[0].slot, 0);
    c.socket.close();
  });

  test('сміттєвий бінарний ввід → 4001, сервер живий', async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'Bad', 'binary');
    const frame = binaryCodec.encodeInputs([input(1)]);
    frame[3 + 4] = 9; // throttle = 9
    c.socket.send(frame);
    assert.equal((await c.closed).code, CLOSE.BAD_MESSAGE);
    const ok = connect(t.wsUrl);
    await ok.join('training', 'Fine');
    ok.socket.close();
  });

  test('бінарний кадр до join → 1003', async () => {
    const c = connect(t.wsUrl);
    await c.opened;
    c.socket.send(binaryCodec.encodeInputs([input(1)]));
    assert.equal((await c.closed).code, CLOSE.UNSUPPORTED_DATA);
  });

  test('/api/stats: тривалість кроку, jitter, лічильники', async () => {
    const c = connect(t.wsUrl);
    await c.join('belt', 'Stat', 'binary');
    await sleep(300);
    const body = await (await fetch(`${t.url}/api/stats`)).json();
    const m = body.matches.find((x) => x.room === 'belt');
    assert.ok(m.tick > 5);
    assert.equal(typeof m.tickMs.avg, 'number');
    assert.equal(typeof m.jitterMs.max, 'number');
    assert.equal(m.overruns, 0);
    assert.ok(m.lastSnapshotBytes > 0);
    c.socket.close();
  });

  test('матч зупиняється, коли виходить останній гравець; /health показує статистику', async () => {
    const c = connect(t.wsUrl);
    await c.join('frontline', 'S', 'binary');
    await sleep(200);
    const health = await (await fetch(`${t.url}/health`)).json();
    const m = health.matches.find((x) => x.room === 'frontline');
    assert.ok(m && m.tick > 3);
    assert.ok(m.tickMs.avg >= 0 && m.jitterMs.max >= 0);
    c.socket.close();
    await c.closed;
    await sleep(100);
    const after = await (await fetch(`${t.url}/health`)).json();
    assert.equal(
      after.matches.find((x) => x.room === 'frontline'),
      undefined,
    );
  });
});
