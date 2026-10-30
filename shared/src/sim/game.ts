import { nextTick, ZERO_SEQ, ZERO_TICK } from '../brand.ts';
import type { Seq, Tick } from '../brand.ts';
import { Bus } from '../bus.ts';
import { createRng } from '../rng.ts';
import type { Rng } from '../rng.ts';
import { Asteroid } from './asteroid.ts';
import { Effect, PICKUP_TYPES, Homing } from './components.ts';
import { enemyController, IDLE } from './controllers.ts';
import type { Controller, Intent } from './controllers.ts';
import type { Team } from './entity.ts';
import { Pickup } from './pickup.ts';
import { Ship } from './ship.ts';
import { Vector2 } from './vector.ts';
import { World } from './world.ts';
import type { WorldEvents } from './world.ts';

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
export interface ArenaConfig {
  readonly enemies: number;
  readonly asteroids: number;
  readonly maxHomingAsteroids: number;
  readonly homingChance: number;
  readonly pickupIntervalSec: number;
  readonly maxPickups: number;
}
export type ArenaKey = keyof ArenaConfig;

export const DEFAULT_ARENA: ArenaConfig = Object.freeze({
  enemies: 2,
  asteroids: 6,
  maxHomingAsteroids: 2,
  homingChance: 0.3,
  pickupIntervalSec: 8,
  maxPickups: 2,
});

const ARENA_LIMITS: Readonly<Record<ArenaKey, readonly [number, number]>> = {
  enemies: [0, 6],
  asteroids: [0, 20],
  maxHomingAsteroids: [0, 6],
  homingChance: [0, 1],
  pickupIntervalSec: [2, 60],
  maxPickups: [0, 5],
};

/** Що завгодно, схоже на конфіг: приходить із мережі, тому значення — unknown. */
export type RawArena = Readonly<Partial<Record<ArenaKey, unknown>>> | null | undefined;

export function normalizeArena(arena?: RawArena): ArenaConfig {
  const pick = (key: ArenaKey): number => {
    const value = arena?.[key];
    const [min, max] = ARENA_LIMITS[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : DEFAULT_ARENA[key];
  };

  return {
    enemies: pick('enemies'),
    asteroids: pick('asteroids'),
    maxHomingAsteroids: pick('maxHomingAsteroids'),
    homingChance: pick('homingChance'),
    pickupIntervalSec: pick('pickupIntervalSec'),
    maxPickups: pick('maxPickups'),
  };
}

/** Команда гравця зі слотом N — "pN"; вороги — "enemy". Команда не б'є по своїх. */
export const teamOf = (slot: number): Team => `p${slot}`;
export const slotOfTeam = (team: Team | null): number =>
  team !== null && /^p\d+$/.test(team) ? Number(team.slice(1)) : -1;

/** Ціле −1/0/1 з будь-чого: NaN, 5, рядок — не "виправляємо", а зводимо до осі. */
const axisOf = (value: unknown): number => {
  const n = typeof value === 'number' ? Math.round(value) : 0;
  return n > 0 ? 1 : n < 0 ? -1 : 0;
};

/**
 * Інтент гравця. Приходить з мережі (де його вже перевірила схема), але це
 * друга лінія оборони: осі — цілі −1/0/1, fire — булеве, решта стає нулем.
 */
export function sanitizeIntent(raw: unknown): Intent {
  const field = (key: string): unknown =>
    typeof raw === 'object' && raw !== null ? Reflect.get(raw, key) : undefined;
  return {
    throttle: axisOf(field('throttle')),
    turn: axisOf(field('turn')),
    turretTurn: axisOf(field('turretTurn')),
    fire: field('fire') === true,
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
 * Game — типізована Bus<GameEvents>: про рахунок повідомляє подією 'scoreChanged'.
 */
export interface GameEvents {
  scoreChanged: { slot: number; score: number; delta: number };
}

/** Запис гравця в грі. */
export interface PlayerRecord {
  readonly slot: number;
  readonly name: string;
  ship: Ship | null;
  intent: Intent;
  /** Останній ВИКОНАНИЙ seq вводу цього гравця (ack). */
  seq: Seq;
  score: number;
  /** Секунд до появи, поки корабель знищено; null — гравець живий. */
  respawn: number | null;
}

export interface GameOptions {
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  readonly rand?: Rng;
  readonly arena?: RawArena;
}

export class Game extends Bus<GameEvents> {
  #players = new Map<number, PlayerRecord>();
  #enemyRespawns: number[] = []; // секунди до появи нового ворога
  #asteroidTimer = 0;
  #pickupTimer: number;
  #rand: Rng;

  readonly seed: number;
  readonly arena: ArenaConfig;
  readonly world: World;
  tick: Tick = ZERO_TICK;

  constructor({ width, height, seed = 1, rand, arena }: GameOptions = {}) {
    super();
    this.#rand = rand ?? createRng(seed);
    this.seed = seed;
    this.arena = normalizeArena(arena);
    this.#pickupTimer = this.arena.pickupIntervalSec;
    this.world = new World({
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      rand: this.#rand,
    });

    // Стрілка зберігає `this` (Game) — звичайний метод у слухачі його б втратив.
    this.world.on('exploded', (detail) => this.#onExploded(detail));
  }

  /** Ворожі кораблі й астероїди. Гравців додає addPlayer. */
  start(): void {
    for (let i = 0; i < this.arena.enemies; i++) this.#spawnShip('enemy');
    for (let i = 0; i < this.arena.asteroids; i++) this.#spawnAsteroid();
  }

  resize(width: number, height: number): void {
    this.world.resize(width, height);
  }

  // ------------------------------------------------------------- гравці

  get players(): ReadonlyMap<number, PlayerRecord> {
    return this.#players;
  }

  addPlayer(slot: number, { name = '' }: { name?: string } = {}): PlayerRecord {
    if (this.#players.has(slot)) throw new Error(`Слот ${slot} зайнятий`);

    const record: PlayerRecord = {
      slot,
      name,
      ship: null,
      intent: IDLE,
      seq: ZERO_SEQ,
      score: 0,
      respawn: null,
    };
    this.#players.set(slot, record);
    this.#spawnPlayerShip(record);
    return record;
  }

  removePlayer(slot: number): boolean {
    const record = this.#players.get(slot);
    if (!record) return false;

    if (record.ship) this.world.despawn(record.ship.id);
    this.#players.delete(slot);
    return true;
  }

  shipOf(slot: number): Ship | null {
    return this.#players.get(slot)?.ship ?? null;
  }

  /** Скільки секунд лишилось до респауну гравця (null, якщо він живий). */
  respawnIn(slot: number): number | null {
    const record = this.#players.get(slot);
    return record?.respawn === null || !record
      ? null
      : Math.max(0, record.respawn);
  }

  /**
   * Встановити інтент гравця, що діятиме на наступному кроці. `seq` — номер
   * вводу, який сервер повідомить клієнту як "підтверджений".
   */
  setInput(slot: number, seq: Seq, intent: unknown): boolean {
    const record = this.#players.get(slot);
    if (!record) return false;

    record.intent = sanitizeIntent(intent);
    record.seq = seq;
    return true;
  }

  // --------------------------------------------------------------- крок

  step(dt: number): void {
    for (const record of this.#players.values()) {
      if (record.ship) record.ship.inputSeq = record.seq;
    }

    this.world.step(dt);
    this.tick = nextTick(this.tick);
    this.#tickRespawns(dt);
    this.#refill(dt);
  }

  #onExploded({ entity, killerTeam }: WorldEvents['exploded']): void {
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

  #recordOf(ship: Ship): PlayerRecord | null {
    for (const record of this.#players.values()) {
      if (record.ship === ship) return record;
    }
    return null;
  }

  #addScore(slot: number, delta: number): void {
    const record = this.#players.get(slot);
    if (!record) return;

    record.score += delta;
    this.emit('scoreChanged', { slot, score: record.score, delta });
  }

  #tickRespawns(dt: number): void {
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
  #refill(dt: number): void {
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

  #spawnPlayerShip(record: PlayerRecord): Ship {
    const ship = this.#spawnShip(teamOf(record.slot), () => record.intent);
    ship.attach('shield', new Effect('shield', SPAWN_SHIELD));
    ship.inputSeq = record.seq;
    record.ship = ship;
    record.respawn = null;
    return ship;
  }

  #spawnShip(team: Team, intentSource: Controller | null = null): Ship {
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

  #spawnAsteroid(): void {
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

  #spawnPickup(): void {
    const type = PICKUP_TYPES[Math.floor(this.#rand() * PICKUP_TYPES.length)];
    if (type === undefined) return; // недосяжно: rand() < 1

    this.world.spawn(new Pickup({ pos: this.#safePosition(16, 80), type }));
  }

  #countHomingAsteroids(): number {
    let count = 0;
    for (const asteroid of this.world.ofKind('asteroid')) {
      if (asteroid.has('homing')) count += 1;
    }
    return count;
  }

  /** Випадкова точка, далека від кораблів, астероїдів і pickup-ів (до 40 спроб). */
  #safePosition(radius: number, margin: number): Vector2 {
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
