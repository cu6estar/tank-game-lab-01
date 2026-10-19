import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Asteroid } from '../src/sim/asteroid.js';
import { Bullet } from '../src/sim/bullet.js';
import { Effect, Homing } from '../src/sim/components.js';
import { Entity } from '../src/sim/entity.js';
import { DEFAULT_ARENA, Game, normalizeArena } from '../src/sim/game.js';
import { Pickup } from '../src/sim/pickup.js';
import { Ship } from '../src/sim/ship.js';
import { Vector2, wrapAngle } from '../src/sim/vector.js';
import { World } from '../src/sim/world.js';

const DT = 1 / 60;

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const run = (seconds, step) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(i);
};

/** Збирає всі події світу за іменем: log.fired, log.hit, log.exploded… */
function record(target, types = ['fired', 'hit', 'exploded', 'pickup']) {
  const log = Object.fromEntries(types.map((type) => [type, []]));
  for (const type of types) {
    target.addEventListener(type, (event) => log[type].push(event.detail));
  }
  return log;
}

const asteroidAt = (x, y, radius = 20) =>
  new Asteroid({ pos: new Vector2(x, y), vel: new Vector2(), radius });

// ----------------------------------------------------------------- Vector2

describe('Vector2', () => {
  it('усі методи чисті: ні this, ні аргумент не мутують', () => {
    const a = new Vector2(1, 2);
    const b = new Vector2(3, 4);

    assert.deepEqual({ ...a.add(b) }, { x: 4, y: 6 });
    for (const result of [
      a.sub(b),
      a.scale(3),
      a.normalize(),
      a.rotate(1),
      a.lerp(b, 0.5),
    ]) {
      assert.ok(result instanceof Vector2 && result !== a && result !== b);
    }
    assert.deepEqual([a.x, a.y, b.x, b.y], [1, 2, 3, 4]);
  });

  it('математика', () => {
    assert.equal(new Vector2(3, 4).length(), 5);
    assert.equal(new Vector2(1, 2).dot(new Vector2(3, 4)), 11);
    const rotated = new Vector2(1, 0).rotate(Math.PI / 2);
    assert.ok(Math.abs(rotated.x) < 1e-12 && Math.abs(rotated.y - 1) < 1e-12);
    const fromAngle = Vector2.fromAngle(Math.PI, 2);
    assert.ok(
      Math.abs(fromAngle.x + 2) < 1e-12 && Math.abs(fromAngle.y) < 1e-12,
    );
    assert.deepEqual({ ...new Vector2().normalize() }, { x: 0, y: 0 });
    assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-12);
  });
});

// ----------------------------------------------------------- Entity / класи

describe('Entity та ієрархія', () => {
  it('id унікальні та приватні, глибина успадкування = 1', () => {
    const a = new Ship({ pos: new Vector2(), team: 'player' });
    const b = new Ship({ pos: new Vector2(), team: 'player' });
    assert.ok(b.id > a.id);
    assert.equal(Object.keys(a).includes('id'), false);
    assert.throws(() => {
      a.id = 5;
    });

    const chain = [];
    for (let p = Object.getPrototypeOf(a); p; p = Object.getPrototypeOf(p)) {
      chain.push(p.constructor.name);
    }
    assert.deepEqual(chain, ['Ship', 'Entity', 'Object']);
    for (const Class of [Bullet, Asteroid, Pickup]) {
      assert.equal(Object.getPrototypeOf(Class), Entity);
    }
  });

  it('#hp приватне, get hp() лише читає', () => {
    const ship = new Ship({ pos: new Vector2(), team: 'player' });
    assert.equal(ship.hp, 100);
    assert.throws(() => {
      ship.hp = 1;
    }, TypeError);
    assert.equal(ship.takeDamage(30), false);
    assert.equal(ship.hp, 70);
    assert.equal(ship.takeDamage(100), true);
    assert.equal(ship.hp, 0);
    assert.equal(ship.alive, false);
    assert.equal(ship.takeDamage(10), false);
  });
});

// ------------------------------------------------------------------- World

describe('World', () => {
  it('є EventTarget; spawn/despawn відкладений, sweep прибирає мертвих', () => {
    const world = new World({ width: 800, height: 600 });
    assert.ok(world instanceof EventTarget);

    const asteroid = world.spawn(asteroidAt(100, 100));
    const pickup = world.spawn(
      new Pickup({ pos: new Vector2(500, 500), type: 'shield' }),
    );
    assert.equal(world.size, 2);
    assert.equal(world.get(asteroid.id), asteroid);

    world.despawn(asteroid.id);
    assert.equal(world.size, 2, 'ще лежить у Map до sweep');
    assert.deepEqual(
      [...world].map((e) => e.id),
      [pickup.id],
    );
    assert.deepEqual([...world.ofKind('asteroid')], []);

    world.step(DT);
    assert.equal(world.size, 1);
    assert.equal(world.get(asteroid.id), undefined);
  });

  it('краї арени "загортаються"', () => {
    const world = new World({ width: 800, height: 600 });
    const asteroid = world.spawn(
      new Asteroid({
        pos: new Vector2(799, 599),
        vel: new Vector2(600, 600),
        radius: 20,
      }),
    );
    world.step(DT);
    assert.ok(asteroid.pos.x >= 0 && asteroid.pos.x < 800);
    assert.ok(asteroid.pos.y >= 0 && asteroid.pos.y < 600);
  });
});

// ------------------------------------------------------------------- fire()

describe('Ship.fire()', () => {
  it('куля вилітає з носа зі швидкістю корабля, живе рівно TTL', () => {
    const world = new World({ width: 2000, height: 2000 });
    const ship = world.spawn(
      new Ship({ pos: new Vector2(500, 500), team: 'player' }),
    );
    ship.turretAngle = Math.PI / 2; // вниз
    ship.vel = new Vector2(100, 0);

    assert.equal(ship.fire(), true);
    const [bullet] = [...world.ofKind('bullet')];
    assert.ok(Math.abs(bullet.pos.x - 500) < 1e-9);
    assert.ok(Math.abs(bullet.pos.y - 538) < 1e-9);
    assert.ok(Math.abs(bullet.vel.x - 100) < 1e-9);
    assert.ok(Math.abs(bullet.vel.y - 560) < 1e-9);
    assert.equal(ship.fire(), false, 'перезарядка');

    run(1.7, () => world.step(DT));
    assert.equal([...world.ofKind('bullet')].length, 0);
    assert.equal(world.size, 1);
  });

  it('баг із this: ship.fire як слухач ламається, три фікси працюють', () => {
    const world = new World({ width: 800, height: 600 });
    const ship = world.spawn(
      new Ship({ pos: new Vector2(400, 300), team: 'player' }),
    );
    const bullets = () => [...world.ofKind('bullet')].length;
    const dispatch = (listener) => listener.call({ name: 'window' }, {});

    assert.throws(() => dispatch(ship.fire), TypeError);
    assert.equal(bullets(), 0);

    dispatch(() => ship.fire());
    assert.equal(bullets(), 1);

    ship.cooldown = 0;
    dispatch(ship.fire.bind(ship));
    assert.equal(bullets(), 2);
  });
});

// ------------------------------------------------- події та колізії (шина)

describe('події світу: fired / hit / exploded / pickup', () => {
  it('fired — при пострілі, з командою та позицією', () => {
    const world = new World({ width: 2000, height: 2000 });
    const log = record(world);
    const ship = world.spawn(
      new Ship({ pos: new Vector2(300, 300), team: 'player' }),
    );

    ship.fire();
    assert.equal(log.fired.length, 1);
    assert.equal(log.fired[0].team, 'player');
    assert.ok(log.fired[0].pos instanceof Vector2);
  });

  it("куля б'є астероїд: hit, потім exploded, куля витрачена", () => {
    const world = new World({ width: 2000, height: 2000 });
    const log = record(world);
    const shooter = world.spawn(
      new Ship({ pos: new Vector2(200, 200), team: 'player' }),
    );
    const asteroid = world.spawn(asteroidAt(400, 200));
    asteroid.hp = 20;
    shooter.turretAngle = 0;
    shooter.fire();

    run(1, () => world.step(DT));

    assert.equal(log.hit.length, 1);
    assert.equal(log.hit[0].kind, 'asteroid');
    assert.equal(log.hit[0].blocked, false);
    assert.equal(log.exploded.length, 1);
    assert.equal(log.exploded[0].entity, asteroid);
    assert.equal(log.exploded[0].killerTeam, 'player');
    assert.equal([...world.ofKind('asteroid')].length, 0);
    assert.equal([...world.ofKind('bullet')].length, 0);
  });

  it("по своїх кулі не б'ють", () => {
    const world = new World({ width: 2000, height: 2000 });
    const log = record(world);
    const a = world.spawn(
      new Ship({ pos: new Vector2(200, 200), team: 'player' }),
    );
    const b = world.spawn(
      new Ship({ pos: new Vector2(300, 200), team: 'player' }),
    );
    a.turretAngle = 0;
    a.fire();
    run(0.5, () => world.step(DT));

    assert.equal(a.hp + b.hp, 200);
    assert.equal(log.hit.length, 0);
  });

  it('ворожий корабель гине після кількох влучань', () => {
    const world = new World({ width: 2000, height: 2000 });
    const log = record(world);
    const player = world.spawn(
      new Ship({
        pos: new Vector2(200, 200),
        team: 'player',
        fireCooldown: 0,
      }),
    );
    const enemy = world.spawn(
      new Ship({ pos: new Vector2(500, 200), team: 'enemy', maxHp: 60 }),
    );
    player.turretAngle = 0;

    run(1.5, () => {
      player.fire();
      world.step(DT);
    });

    assert.equal(enemy.alive, false);
    assert.equal(enemy.hp, 0);
    assert.equal(log.hit.filter((h) => h.kind === 'ship').length, 3);
    assert.equal(log.exploded.filter((e) => e.kind === 'ship').length, 1);
  });

  it('астероїд, що врізався, шкодить; щит гасить, але hit.blocked = true', () => {
    const world = new World({ width: 2000, height: 2000 });
    const log = record(world);
    const ship = world.spawn(
      new Ship({ pos: new Vector2(200, 200), team: 'player' }),
    );
    world.spawn(asteroidAt(210, 200));
    world.step(DT);
    assert.equal(ship.hp, 75);
    assert.equal(log.hit.at(-1).blocked, false);

    const shielded = world.spawn(
      new Ship({ pos: new Vector2(1000, 1000), team: 'player' }),
    );
    shielded.attach('shield', new Effect('shield', 5));
    world.spawn(asteroidAt(1010, 1000));
    world.step(DT);
    assert.equal(shielded.hp, 100);
    assert.equal(log.hit.at(-1).blocked, true);
  });

  it('pickup дає компонент-ефект, зникає, шле подію; ефект спливає', () => {
    const world = new World({ width: 2000, height: 2000 });
    const log = record(world);
    const ship = world.spawn(
      new Ship({ pos: new Vector2(200, 200), team: 'player', fireCooldown: 1 }),
    );
    world.spawn(new Pickup({ pos: new Vector2(210, 200), type: 'rapidFire' }));
    world.step(DT);

    assert.equal(ship.has('rapidFire'), true);
    assert.equal([...world.ofKind('pickup')].length, 0);
    assert.equal(log.pickup[0].type, 'rapidFire');

    ship.fire();
    assert.ok(Math.abs(ship.cooldown - 0.35) < 1e-9);
    run(8.1, () => world.step(DT));
    assert.equal(ship.has('rapidFire'), false);
  });
});

describe('homing', () => {
  it('самонавідна куля влучає туди, куди проста промахується', () => {
    const shoot = (withHoming) => {
      const world = new World({ width: 3000, height: 3000 });
      const log = record(world);
      const ship = world.spawn(
        new Ship({
          pos: new Vector2(200, 1000),
          team: 'player',
          fireCooldown: 0,
        }),
      );
      const target = world.spawn(asteroidAt(700, 1180, 25));
      target.hp = 10;
      ship.turretAngle = 0;
      if (withHoming) ship.attach('homingShots', new Effect('homingShots', 10));
      ship.fire();
      run(1.5, () => world.step(DT));
      return log.exploded.some((e) => e.entity === target);
    };

    assert.equal(shoot(false), false);
    assert.equal(shoot(true), true);
  });

  it('компонент Homing зберігає швидкість і притягує астероїд до корабля', () => {
    const world = new World({ width: 3000, height: 3000 });
    const ship = world.spawn(
      new Ship({ pos: new Vector2(1000, 1000), team: 'player' }),
    );
    const asteroid = world.spawn(
      new Asteroid({
        pos: new Vector2(1000, 1300),
        vel: Vector2.fromAngle(0, 85),
        radius: 30,
      }),
    );
    asteroid.attach(
      'homing',
      new Homing({ targetKinds: ['ship'], turnRate: 0.9, range: 450 }),
    );
    const before = asteroid.pos.sub(ship.pos).length();

    run(1, () => world.step(DT));

    assert.ok(Math.abs(asteroid.vel.length() - 85) < 1e-6);
    assert.ok(asteroid.pos.sub(ship.pos).length() < before - 20);
  });
});

// -------------------------------------------------------------------- Game

describe('Game', () => {
  it('є EventTarget; scoreChanged приходить з новим рахунком', () => {
    const game = new Game({ width: 2000, height: 1500, rand: seeded(7) });
    assert.ok(game instanceof EventTarget);
    game.start();

    for (const entity of game.world) {
      if (entity !== game.player) game.world.despawn(entity.id);
    }
    game.step(DT, null);

    const scores = [];
    game.addEventListener('scoreChanged', (event) => scores.push(event.detail));

    const player = game.player;
    player.fireCooldown = 0;
    player.pos = new Vector2(300, 300);
    player.turretAngle = 0;
    const enemy = game.world.spawn(
      new Ship({ pos: new Vector2(600, 300), team: 'enemy', maxHp: 60 }),
    );

    for (let i = 0; i < 300 && enemy.alive; i++) {
      player.fire();
      game.step(DT, null);
    }

    assert.equal(enemy.alive, false);
    assert.equal(game.score, 100);
    assert.deepEqual(scores, [{ score: 100, delta: 100 }]);
  });

  it('респаун через 2 с: новий корабель із щитом і повним HP', () => {
    const game = new Game({ width: 1600, height: 1200, rand: seeded(1) });
    game.start();
    const player = game.player;

    game.world.spawn(asteroidAt(player.pos.x + 5, player.pos.y, 30));
    player.takeDamage(75);

    for (let i = 0; i < 10 && game.player === player; i++) game.step(DT, null);
    assert.equal(game.player, null);
    assert.ok(game.respawnIn > 1.9 && game.respawnIn <= 2);

    let steps = 0;
    while (!game.player && steps < 200) {
      game.step(DT, null);
      steps += 1;
    }

    assert.ok(game.player && game.player !== player);
    assert.ok(steps >= 116 && steps <= 121, `респаун за ${steps} кроків`);
    assert.equal(game.player.hp, 100);
    assert.equal(game.player.has('shield'), true);
    assert.equal(game.respawnIn, null);
  });

  it('конфіг арени з лобі застосовується й обмежується', () => {
    const game = new Game({
      width: 1600,
      height: 1200,
      rand: seeded(3),
      arena: { enemies: 4, asteroids: 3, maxPickups: 0 },
    });
    game.start();

    assert.equal([...game.world.ofKind('ship')].length, 1 + 4);
    assert.equal([...game.world.ofKind('asteroid')].length, 3);

    assert.deepEqual(normalizeArena(undefined), { ...DEFAULT_ARENA });
    const clamped = normalizeArena({
      enemies: 9999,
      asteroids: -5,
      homingChance: 7,
      pickupIntervalSec: 'часто',
      хакерське: 1,
    });
    assert.equal(clamped.enemies, 6);
    assert.equal(clamped.asteroids, 0);
    assert.equal(clamped.homingChance, 1);
    assert.equal(clamped.pickupIntervalSec, DEFAULT_ARENA.pickupIntervalSec);
    assert.equal('хакерське' in clamped, false);
  });

  it('довгий прогін стабільний: без NaN, кількість сутностей обмежена', () => {
    const game = new Game({ width: 1280, height: 720, rand: seeded(42) });
    game.start();
    const keys = new Set(['ArrowUp', 'KeyX']);
    const input = { isDown: (code) => keys.has(code) };
    let max = 0;

    run(120, (i) => {
      if (i % 20 === 0) game.player?.fire();
      game.step(DT, input);
      max = Math.max(max, game.world.size);
      for (const e of game.world) {
        assert.ok(Number.isFinite(e.pos.x) && Number.isFinite(e.pos.y), e.kind);
      }
    });

    assert.ok(max < 80, `макс. сутностей ${max}`);
  });
});

// ------------------------------------------------- sim не залежить від UI

describe('sim ізольований від audio/HUD', () => {
  const simDir = fileURLToPath(new URL('../src/sim/', import.meta.url));
  const files = readdirSync(simDir).filter((name) => name.endsWith('.js'));

  it('жоден файл sim не імпортує нічого поза src/sim', () => {
    assert.ok(files.length >= 10);

    for (const file of files) {
      const source = readFileSync(simDir + file, 'utf8');
      const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      );

      for (const specifier of specifiers) {
        assert.ok(
          /^\.\/[\w-]+\.js$/.test(specifier),
          `${file} імпортує "${specifier}" — sim може залежати лише від своїх файлів`,
        );
        assert.ok(
          !/audio|hud|lobby|render/i.test(specifier),
          `${file} імпортує ${specifier}`,
        );
      }
    }
  });

  it('не згадує DOM і Web Audio', () => {
    for (const file of files) {
      const source = readFileSync(simDir + file, 'utf8');
      assert.ok(
        !/\b(document|window|AudioContext|AudioBuffer)\b/.test(source),
        `${file} звертається до браузерного API`,
      );
    }
  });
});
