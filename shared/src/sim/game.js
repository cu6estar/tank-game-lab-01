import { createRng } from '../rng.js';
import { Asteroid } from './asteroid.js';
import { Effect, EFFECT_TYPES, Homing } from './components.js';
import { enemyController, IDLE } from './controllers.js';
import { Pickup } from './pickup.js';
import { Ship } from './ship.js';
import { Vector2 } from './vector.js';
import { World } from './world.js';

export const RESPAWN_DELAY = 2; // секунд
export const SPAWN_SHIELD = 2; // секунд невразливості після (ре)спауну
const ASTEROID_INTERVAL = 2;

const SCORE_ENEMY = 100;
const SCORE_PLAYER = 150;
const SCORE_ASTEROID = 10;
const SCORE_HOMING_ASTEROID = 25;

/**
 * Конфіг арени. Приходить із кімнати лобі (`room.arena` у /api/rooms),
 * тобто з мережі — тому кожне поле обмежене розумним діапазоном.
 */
export const DEFAULT_ARENA = Object.freeze({
  enemies: 2,
  asteroids: 6,
  maxHomingAsteroids: 2,
  homingChance: 0.3,
  pickupIntervalSec: 8,
  maxPickups: 2,
});

const ARENA_LIMITS = {
  enemies: [0, 6],
  asteroids: [0, 20],
  maxHomingAsteroids: [0, 6],
  homingChance: [0, 1],
  pickupIntervalSec: [2, 60],
  maxPickups: [0, 5],
};

export function normalizeArena(arena = {}) {
  const result = { ...DEFAULT_ARENA };

  for (const [key, [min, max]] of Object.entries(ARENA_LIMITS)) {
    const value = arena?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Math.min(max, Math.max(min, value));
    }
  }
  return result;
}

/** Команда гравця зі слотом N — "pN"; вороги — "enemy". Команда не б'є по своїх. */
export const teamOf = (slot) => `p${slot}`;
export const slotOfTeam = (team) =>
  typeof team === 'string' && /^p\d+$/.test(team) ? Number(team.slice(1)) : -1;

const clamp1 = (value) => Math.max(-1, Math.min(1, Math.round(value) || 0));

/**
 * Інтент гравця. Приходить з мережі, тож чистимо: осі — цілі −1/0/1,
 * fire — булеве. Інше (NaN, 5, рядки) стає нулем.
 */
export function sanitizeIntent(raw) {
  return {
    throttle: clamp1(raw?.throttle),
    turn: clamp1(raw?.turn),
    turretTurn: clamp1(raw?.turretTurn),
    fire: raw?.fire === true,
  };
}

/**
 * Правила гри поверх World для кількох гравців: рахунок, респаун через 2 с,
 * поповнення астероїдів і pickup-ів. Вороги з AI — як і раніше.
 *
 * Гравці живуть у слотах (0..7). Гравець керується ІНТЕНТОМ: сервер ставить
 * `setInput(slot, seq, intent)` перед кроком, корабель читає його через
 * контролер. Клієнт координат не шле, світ рахує лише `step()`.
 *
 * Детермінізм: уся випадковість — `rand`, засіяний генератор; жодного
 * Math.random(), Date.now(), порядку ключів об'єкта. Той самий seed і та сама
 * послідовність викликів дають той самий стан у браузері та в Node.
 *
 * Game — EventTarget: про рахунок повідомляє подією 'scoreChanged'.
 */
export class Game extends EventTarget {
  #players = new Map(); // slot → { slot, name, ship, intent, seq, score, respawn }
  #enemyRespawns = []; // секунди до появи нового ворога
  #asteroidTimer = 0;
  #pickupTimer;
  #rand;

  constructor({ width, height, seed = 1, rand, arena } = {}) {
    super();
    this.#rand = rand ?? createRng(seed);
    this.seed = seed;
    this.arena = normalizeArena(arena);
    this.#pickupTimer = this.arena.pickupIntervalSec;
    this.world = new World({ width, height, rand: this.#rand });
    this.tick = 0;

    // Стрілка зберігає `this` (Game) — звичайний метод у слухачі його б втратив.
    this.world.addEventListener('exploded', (event) =>
      this.#onExploded(event.detail),
    );
  }

  /** Ворожі кораблі й астероїди. Гравців додає addPlayer. */
  start() {
    for (let i = 0; i < this.arena.enemies; i++) this.#spawnShip('enemy');
    for (let i = 0; i < this.arena.asteroids; i++) this.#spawnAsteroid();
  }

  resize(width, height) {
    this.world.resize(width, height);
  }

  // ------------------------------------------------------------- гравці

  get players() {
    return this.#players;
  }

  addPlayer(slot, { name = '' } = {}) {
    if (this.#players.has(slot)) throw new Error(`Слот ${slot} зайнятий`);

    const record = {
      slot,
      name,
      ship: null,
      intent: IDLE,
      seq: 0, // останній ВИКОНАНИЙ seq вводу цього гравця
      score: 0,
      respawn: null, // секунд до появи, поки корабель знищено
    };
    this.#players.set(slot, record);
    this.#spawnPlayerShip(record);
    return record;
  }

  removePlayer(slot) {
    const record = this.#players.get(slot);
    if (!record) return false;

    if (record.ship) this.world.despawn(record.ship.id);
    this.#players.delete(slot);
    return true;
  }

  shipOf(slot) {
    return this.#players.get(slot)?.ship ?? null;
  }

  /** Скільки секунд лишилось до респауну гравця (null, якщо він живий). */
  respawnIn(slot) {
    const record = this.#players.get(slot);
    return record?.respawn === null || !record
      ? null
      : Math.max(0, record.respawn);
  }

  /**
   * Встановити інтент гравця, що діятиме на наступному кроці. `seq` — номер
   * вводу, який сервер повідомить клієнту як "підтверджений".
   */
  setInput(slot, seq, intent) {
    const record = this.#players.get(slot);
    if (!record) return false;

    record.intent = sanitizeIntent(intent);
    record.seq = seq;
    return true;
  }

  // --------------------------------------------------------------- крок

  step(dt) {
    for (const record of this.#players.values()) {
      if (record.ship) record.ship.inputSeq = record.seq;
    }

    this.world.step(dt);
    this.tick += 1;
    this.#tickRespawns(dt);
    this.#refill(dt);
  }

  #onExploded({ entity, killerTeam }) {
    const killerSlot = slotOfTeam(killerTeam);

    if (entity.kind === 'ship') {
      const record = this.#recordOf(entity);
      if (record) {
        record.ship = null;
        record.respawn = RESPAWN_DELAY;
      } else {
        this.#enemyRespawns.push(RESPAWN_DELAY);
      }
      if (killerSlot >= 0) {
        this.#addScore(killerSlot, record ? SCORE_PLAYER : SCORE_ENEMY);
      }
    } else if (entity.kind === 'asteroid' && killerSlot >= 0) {
      this.#addScore(
        killerSlot,
        entity.has('homing') ? SCORE_HOMING_ASTEROID : SCORE_ASTEROID,
      );
    }
  }

  #recordOf(ship) {
    for (const record of this.#players.values()) {
      if (record.ship === ship) return record;
    }
    return null;
  }

  #addScore(slot, delta) {
    const record = this.#players.get(slot);
    if (!record) return;

    record.score += delta;
    this.dispatchEvent(
      new CustomEvent('scoreChanged', {
        detail: { slot, score: record.score, delta },
      }),
    );
  }

  #tickRespawns(dt) {
    for (const record of this.#players.values()) {
      if (record.respawn === null) continue;
      record.respawn -= dt;
      if (record.respawn <= 0) this.#spawnPlayerShip(record);
    }

    const waiting = [];
    for (const timer of this.#enemyRespawns) {
      const left = timer - dt;
      if (left > 0) {
        waiting.push(left);
        continue;
      }
      this.#spawnShip('enemy').attach(
        'shield',
        new Effect('shield', SPAWN_SHIELD),
      );
    }
    this.#enemyRespawns = waiting;
  }

  /** Тримає на арені цільну кількість астероїдів і pickup-ів. */
  #refill(dt) {
    let asteroids = 0;
    let pickups = 0;
    for (const entity of this.world) {
      if (entity.kind === 'asteroid') asteroids += 1;
      if (entity.kind === 'pickup') pickups += 1;
    }

    this.#asteroidTimer -= dt;
    if (asteroids < this.arena.asteroids && this.#asteroidTimer <= 0) {
      this.#spawnAsteroid();
      this.#asteroidTimer = ASTEROID_INTERVAL;
    }

    this.#pickupTimer -= dt;
    if (pickups < this.arena.maxPickups && this.#pickupTimer <= 0) {
      this.#spawnPickup();
      this.#pickupTimer = this.arena.pickupIntervalSec;
    }
  }

  #spawnPlayerShip(record) {
    const ship = this.#spawnShip(teamOf(record.slot), () => record.intent);
    ship.attach('shield', new Effect('shield', SPAWN_SHIELD));
    ship.inputSeq = record.seq;
    record.ship = ship;
    record.respawn = null;
    return ship;
  }

  #spawnShip(team, intentSource = null) {
    const isEnemy = team === 'enemy';
    const ship = new Ship({
      pos: this.#safePosition(28, 200),
      angle: this.#rand() * Math.PI * 2,
      team,
      controller: isEnemy ? enemyController : intentSource,
      ...(isEnemy ? { maxHp: 60, maxSpeed: 130, fireCooldown: 1.2 } : {}),
    });

    this.world.spawn(ship);
    return ship;
  }

  #spawnAsteroid() {
    const radius = 20 + this.#rand() * 26;
    const heading = this.#rand() * Math.PI * 2;
    const homing =
      this.#countHomingAsteroids() < this.arena.maxHomingAsteroids &&
      this.#rand() < this.arena.homingChance;

    const asteroid = new Asteroid({
      pos: this.#safePosition(radius, 160),
      vel: Vector2.fromAngle(heading, homing ? 85 : 30 + this.#rand() * 60),
      radius,
      spin: (this.#rand() - 0.5) * 2,
      shapeSeed: Math.floor(this.#rand() * 0x10000),
    });

    if (homing) {
      // Той самий компонент, що й у homing-куль: клас Asteroid про нього не знає.
      asteroid.attach(
        'homing',
        new Homing({ targetKinds: ['ship'], turnRate: 0.9, range: 450 }),
      );
    }

    this.world.spawn(asteroid);
  }

  #spawnPickup() {
    const types = Object.keys(EFFECT_TYPES);
    const type = types[Math.floor(this.#rand() * types.length)];

    this.world.spawn(new Pickup({ pos: this.#safePosition(16, 80), type }));
  }

  #countHomingAsteroids() {
    let count = 0;
    for (const asteroid of this.world.ofKind('asteroid')) {
      if (asteroid.has('homing')) count += 1;
    }
    return count;
  }

  /** Випадкова точка, далека від кораблів, астероїдів і pickup-ів (до 40 спроб). */
  #safePosition(radius, margin) {
    const { width, height } = this.world;
    let candidate = new Vector2(width / 2, height / 2);

    for (let attempt = 0; attempt < 40; attempt++) {
      candidate = new Vector2(
        radius + this.#rand() * Math.max(1, width - radius * 2),
        radius + this.#rand() * Math.max(1, height - radius * 2),
      );

      const clear = ![...this.world].some(
        (other) =>
          (other.kind === 'ship' ||
            other.kind === 'asteroid' ||
            other.kind === 'pickup') &&
          candidate.sub(other.pos).length() < other.radius + radius + margin,
      );

      if (clear) return candidate;
    }

    return candidate;
  }
}
