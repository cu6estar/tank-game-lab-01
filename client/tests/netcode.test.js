import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { binaryCodec } from '@tank/shared/codec/index.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DT,
  TICK_MS,
} from '@tank/shared/constants.js';
import { buildSnapshot } from '@tank/shared/protocol/snapshot.js';
import { Game } from '@tank/shared/sim/game.js';
import { Ship } from '@tank/shared/sim/ship.js';
import { Vector2 } from '@tank/shared/sim/vector.js';
import { interpolateList, lerpWrapped } from '../src/net/interpolate.js';
import { createLagInjector } from '../src/net/lag.js';
import { Predictor } from '../src/net/predictor.js';
import { SnapshotBuffer } from '../src/net/snapshot-buffer.js';

const SIZE = { width: ARENA_WIDTH, height: ARENA_HEIGHT };

/** Керовані таймери: час стоїть, поки тест його не посунув. */
function fakeTimers() {
  let now = 0;
  const queue = [];
  return {
    timers: {
      now: () => now,
      setTimeout(fn, ms) {
        const entry = { at: now + ms, fn };
        queue.push(entry);
        return entry;
      },
      clearTimeout(entry) {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
      },
    },
    advance(ms) {
      now += ms;
      for (const entry of queue
        .filter((e) => e.at <= now)
        .sort((a, b) => a.at - b.at)) {
        queue.splice(queue.indexOf(entry), 1);
        entry.fn();
      }
    },
    get pending() {
      return queue.length;
    },
  };
}

describe('інжектор лагу', () => {
  it('без налаштувань пропускає одразу', () => {
    const lag = createLagInjector();
    let ran = 0;
    assert.equal(
      lag.pass(() => ran++),
      'now',
    );
    assert.equal(ran, 1);
    assert.equal(lag.active, false);
  });

  it('lag=100 — по 50 мс на кожен напрямок', () => {
    const clock = fakeTimers();
    const lag = createLagInjector({
      config: { lag: 100 },
      timers: clock.timers,
    });
    let ran = 0;
    assert.equal(
      lag.pass(() => ran++),
      'later',
    );
    clock.advance(49);
    assert.equal(ran, 0);
    clock.advance(1);
    assert.equal(ran, 1);
  });

  it('jitter не міняє порядок пакетів одного напрямку (як TCP)', () => {
    const clock = fakeTimers();
    const values = [0.99, 1, 0.99, 0.5]; // (drop, jitter) на пакет: A випало +40 мс, B — 0 мс
    const lag = createLagInjector({
      config: { lag: 0, jitter: 40 },
      random: () => values.shift() ?? 0.5,
      timers: clock.timers,
    });
    const order = [];
    lag.pass(() => order.push('A'), 'in'); // випало +40 мс
    lag.pass(() => order.push('B'), 'in'); // випало 0 мс, але не може обігнати A
    clock.advance(100);
    assert.deepEqual(order, ['A', 'B']);
  });

  it('напрямки незалежні: "in" не чекає на "out"', () => {
    const clock = fakeTimers();
    const lag = createLagInjector({
      config: { lag: 100 },
      timers: clock.timers,
    });
    const order = [];
    lag.pass(() => order.push('out'), 'out');
    clock.advance(10);
    lag.pass(() => order.push('in'), 'in');
    clock.advance(45);
    assert.deepEqual(order, ['out']);
    clock.advance(10);
    assert.deepEqual(order, ['out', 'in']);
  });

  it('drop=100 відкидає все, drop=0 — нічого', () => {
    const all = createLagInjector({ config: { drop: 100 } });
    assert.equal(
      all.pass(() => assert.fail('не мало виконатись')),
      'dropped',
    );
    assert.equal(all.stats.dropped, 1);

    const none = createLagInjector({ config: { drop: 0 }, random: () => 0 });
    assert.equal(
      none.pass(() => {}),
      'now',
    );
  });

  it('?lag=&jitter=&drop= з URL і обмеження значень', () => {
    const lag = createLagInjector();
    lag.configureFromQuery('?lag=100&jitter=30&drop=2&room=x');
    assert.deepEqual(lag.config, { lag: 100, jitter: 30, drop: 2 });
    lag.configure({ lag: 99999, drop: -5, jitter: 'abc' });
    assert.deepEqual(lag.config, { lag: 2000, jitter: 30, drop: 0 });
  });

  it('clear() скасовує пакети, що ще летять', () => {
    const clock = fakeTimers();
    const lag = createLagInjector({
      config: { lag: 100 },
      timers: clock.timers,
    });
    lag.pass(() => assert.fail('скасовано'));
    lag.clear();
    clock.advance(500);
  });
});

const snap = (tick, extra = {}) => ({
  tick,
  players: [],
  ships: [],
  bullets: [],
  asteroids: [],
  pickups: [],
  events: [],
  ...extra,
});

describe('буфер знімків', () => {
  it('дублікати й запізнілі знімки не потрапляють у історію', () => {
    const buffer = new SnapshotBuffer();
    assert.equal(buffer.push(snap(5), 0), 'ok');
    assert.equal(buffer.push(snap(5), 1), 'duplicate');
    assert.equal(buffer.push(snap(7), 2), 'ok');
    assert.equal(buffer.push(snap(6), 3), 'late');
    assert.equal(buffer.size, 2);
    assert.equal(buffer.newest.tick, 7);
  });

  it('зсув годинників = мінімум (arrival − tickTime), а не середнє', () => {
    const buffer = new SnapshotBuffer();
    // затримки 80, 20, 120 мс; годинник клієнта відстає на 1000 мс
    buffer.push(snap(1), 1000 + TICK_MS + 80);
    buffer.push(snap(2), 1000 + 2 * TICK_MS + 20);
    buffer.push(snap(3), 1000 + 3 * TICK_MS + 120);
    assert.ok(Math.abs(buffer.offset - 1020) < 1e-9);
  });

  it('sample() повертає пару та частку між знімками', () => {
    const buffer = new SnapshotBuffer();
    for (const tick of [10, 11, 12]) buffer.push(snap(tick), tick * TICK_MS);
    const at = (tick) => buffer.sample(tick * TICK_MS);

    const mid = at(10.5);
    assert.equal(mid.a.tick, 10);
    assert.equal(mid.b.tick, 11);
    assert.ok(Math.abs(mid.alpha - 0.5) < 1e-9);

    const exact = at(11);
    assert.equal(exact.a.tick, 11);
    assert.equal(exact.b.tick, 12);
    assert.ok(Math.abs(exact.alpha) < 1e-9);

    assert.equal(at(9).a.tick, 10, 'до початку історії: перший знімок');
  });

  it('після останнього знімка — starved, тримаємо останній', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1), 0);
    buffer.push(snap(2), 0);
    const s = buffer.sample(5 * TICK_MS);
    assert.equal(s.starved, true);
    assert.equal(s.a.tick, 2);
    assert.equal(buffer.sample(2 * TICK_MS).starved, false);
  });

  it('ємність обмежена', () => {
    const buffer = new SnapshotBuffer({ capacity: 3 });
    for (let t = 1; t <= 10; t++) buffer.push(snap(t), 0);
    assert.equal(buffer.size, 3);
  });
});

describe('інтерполяція', () => {
  it('через край арени — найкоротшим шляхом', () => {
    assert.ok(Math.abs(lerpWrapped(1270, 10, 0.5, 1280) - 0) < 1e-9);
    assert.ok(Math.abs(lerpWrapped(10, 1270, 0.5, 1280) - 0) < 1e-9);
    assert.ok(Math.abs(lerpWrapped(100, 200, 0.25, 1280) - 125) < 1e-9);
  });

  it('з’явилась між знімками — ще не малюється; зникла — малюється в старому стані', () => {
    const a = [
      { id: 1, x: 100, y: 0 },
      { id: 2, x: 0, y: 0 },
    ];
    const b = [
      { id: 1, x: 200, y: 0 },
      { id: 3, x: 5, y: 5 },
    ];
    const out = interpolateList(a, b, 0.5, SIZE);
    assert.deepEqual(out.map((e) => e.id).sort(), [1, 2]);
    assert.equal(out.find((e) => e.id === 1).x, 150);
    assert.equal(out.find((e) => e.id === 2).x, 0);
  });
});

/**
 * Серверний світ + клієнтський предиктор, між ними "мережа" з фіксованою затримкою
 * в кроках. Знімки проходять через ТОЙ САМИЙ бінарний кодек, що в грі, тож
 * похибка квантування (швидкість 1/16, кут Int16…) входить у вимір.
 */
function runNetcode({
  ticks = 240,
  up = 3,
  down = 3,
  breakIt = false,
  script,
}) {
  const game = new Game({
    ...SIZE,
    seed: 11,
    arena: { enemies: 0, asteroids: 0, maxPickups: 0 },
  });
  game.start();
  game.addPlayer(0, { name: 'T' });

  const predictor = new Predictor({ ...SIZE });
  const inputs = [];
  const arrivals = new Map(); // клієнтський крок → знімок
  const corrections = [];

  const originalBehave = Ship.prototype.behave;
  let seed = 1;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  if (breakIt) {
    Ship.prototype.behave = function broken(dt, world) {
      originalBehave.call(this, dt, world);
      this.vel = this.vel.add(
        new Vector2((rnd() - 0.5) * 18, (rnd() - 0.5) * 18),
      );
    };
  }

  try {
    for (let n = 1; n <= ticks; n++) {
      // клієнт: ввід №n
      const input = { seq: n, ...script(n) };
      inputs[n] = input;
      predictor.step(input);
      predictor.stepBullets();

      // сервер: застосовує ввід, надісланий `up` кроків тому
      const applied = inputs[n - up];
      if (applied) game.setInput(0, applied.seq, applied);
      game.step(DT);
      const snapshot = binaryCodec.decodeSnapshot(
        binaryCodec.encodeSnapshot(buildSnapshot(game, [])),
      );
      arrivals.set(n + down, snapshot);

      // клієнт: приймає знімок, що дійшов у цей крок
      const arrived = arrivals.get(n);
      if (arrived) corrections.push(predictor.reconcile(arrived, 0));
      predictor.smooth(DT);
    }
  } finally {
    Ship.prototype.behave = originalBehave;
  }
  return { predictor, corrections, game };
}

const drive = (n) => ({
  throttle: n % 90 < 60 ? 1 : 0,
  turn: n % 50 < 20 ? 1 : n % 50 < 35 ? -1 : 0,
  turretTurn: n % 70 < 30 ? 1 : 0,
  fire: n % 40 === 0,
});

describe('передбачення і звірка (shared Game як "сервер")', () => {
  it('детермінована симуляція ⇒ корекції ≈ 0 попри затримку мережі', () => {
    const { corrections } = runNetcode({ script: drive, up: 4, down: 4 });
    const worst = Math.max(...corrections.slice(10));
    // залишок — лише квантування швидкості (1/16 px/с) і таймерів у знімку
    assert.ok(worst < 0.5, `найбільша корекція ${worst} px`);
  });

  it('Math.random у фізиці клієнта ⇒ корекції виростають на порядки', () => {
    const clean = runNetcode({ script: drive, up: 4, down: 4 });
    const broken = runNetcode({ script: drive, up: 4, down: 4, breakIt: true });
    const mean = (xs) =>
      xs.slice(10).reduce((a, b) => a + b, 0) / (xs.length - 10);
    assert.ok(
      mean(broken.corrections) > 20 * Math.max(mean(clean.corrections), 0.01),
      `clean=${mean(clean.corrections)} broken=${mean(broken.corrections)}`,
    );
    assert.ok(mean(broken.corrections) > 0.5);
  });

  it('після звірки непідтверджені ввід лишаються в буфері, підтверджені — ні', () => {
    const { predictor } = runNetcode({
      ticks: 100,
      up: 2,
      down: 3,
      script: drive,
    });
    // у польоті: up + down вводів
    assert.ok(
      predictor.pending.length >= 4 && predictor.pending.length <= 7,
      String(predictor.pending.length),
    );
  });

  it('передбачена куля живе, поки сервер її підтверджує, і зникає разом із серверною', () => {
    const shoot = (n) => ({
      throttle: 0,
      turn: 0,
      turretTurn: 0,
      fire: n === 5,
    });
    const early = runNetcode({ ticks: 20, up: 2, down: 2, script: shoot });
    assert.equal(
      early.predictor.bullets.length,
      1,
      'куля показується, поки летить',
    );
    // ttl кулі 1.6 с = 48 кроків: на кроці 80 її давно немає ні на сервері, ні в клієнта
    const late = runNetcode({ ticks: 80, up: 2, down: 2, script: shoot });
    assert.equal(late.predictor.bullets.length, 0);
  });

  it('помилка згладжується: offset → 0 за ~100 мс і не стрибає', () => {
    const predictor = new Predictor({ ...SIZE });
    predictor.offset = { x: 30, y: 0, angle: 0, turret: 0 };
    let steps = 0;
    while (Math.abs(predictor.offset.x) > 1.5 && steps < 30) {
      predictor.smooth(DT);
      steps++;
    }
    assert.ok(steps * DT <= 0.12, `згладжування тривало ${steps * DT} с`);
  });

  it('велика розбіжність (телепорт/респаун) показується одразу, без "ковзання"', () => {
    const predictor = new Predictor({ ...SIZE });
    const base = {
      slot: 0,
      id: 1,
      x: 100,
      y: 100,
      vx: 0,
      vy: 0,
      angle: 0,
      turret: 0,
      hp: 100,
      cooldown: 0,
      shield: 0,
      rapid: 0,
      homing: 0,
    };
    const make = (x) => ({
      tick: 1,
      players: [{ slot: 0, ack: 0, score: 0 }],
      ships: [{ ...base, x }],
      bullets: [],
      asteroids: [],
      pickups: [],
      events: [],
    });
    predictor.reconcile(make(100), 0);
    const jump = predictor.reconcile(make(500), 0);
    assert.ok(jump > 100);
    assert.equal(predictor.offset.x, 0);
  });

  it('"тупий клієнт" (enabled=false) ніколи не симулює', () => {
    const predictor = new Predictor({ ...SIZE });
    predictor.enabled = false;
    predictor.step({
      seq: 1,
      throttle: 1,
      turn: 0,
      turretTurn: 0,
      fire: false,
    });
    assert.equal(predictor.alive, false);
    assert.equal(predictor.pending.length, 1);
  });
});
