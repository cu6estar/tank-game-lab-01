import { World } from './world.js';
import { Ship } from './ship.js';
import { Asteroid } from './asteroid.js';
import { Pickup } from './pickup.js';
import { Effect, EFFECT_TYPES, Homing } from './components.js';
import { enemyController, playerController } from './controllers.js';
import { Vector2 } from './vector.js';

const RESPAWN_DELAY = 2; // секунд
const SPAWN_SHIELD = 2; // секунд невразливості після респауну
const ASTEROID_INTERVAL = 2;

const SCORE_ENEMY = 100;
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

/**
 * Правила гри поверх World: рахунок, респаун кораблів через 2 с,
 * поповнення астероїдів та pickup-ів. World нічого про це не знає —
 * він лише сповіщає ('exploded'), а Game підписаний на ці події.
 *
 * Сам Game теж EventTarget: про зміну рахунку він повідомляє подією
 * 'scoreChanged', а HUD слухає її і не імпортується в sim.
 */
export class Game extends EventTarget {
  #respawns = []; // { timer, team }
  #asteroidTimer = 0;
  #pickupTimer;
  #rand;

  constructor({ width, height, rand = Math.random, arena } = {}) {
    super();
    this.#rand = rand;
    this.arena = normalizeArena(arena);
    this.#pickupTimer = this.arena.pickupIntervalSec;
    this.world = new World({ width, height });
    this.player = null;
    this.score = 0;

    // Стрілка зберігає `this` (Game) — звичайний метод у слухачі його б втратив.
    this.world.addEventListener('exploded', (event) =>
      this.#onExploded(event.detail),
    );
  }

  start() {
    this.#spawnShip('player');
    for (let i = 0; i < this.arena.enemies; i++) this.#spawnShip('enemy');
    for (let i = 0; i < this.arena.asteroids; i++) this.#spawnAsteroid();
  }

  resize(width, height) {
    this.world.resize(width, height);
  }

  /** Скільки секунд лишилось до респауну гравця (null, якщо гравець живий). */
  get respawnIn() {
    const entry = this.#respawns.find((r) => r.team === 'player');
    return entry ? Math.max(0, entry.timer) : null;
  }

  step(dt, inputs) {
    this.world.step(dt, inputs);
    this.#tickRespawns(dt);
    this.#refill(dt);
  }

  #onExploded({ entity, killerTeam }) {
    if (entity.kind === 'ship') {
      if (entity === this.player) this.player = null;
      this.#respawns.push({ timer: RESPAWN_DELAY, team: entity.team });
      if (killerTeam === 'player') this.#addScore(SCORE_ENEMY);
    } else if (entity.kind === 'asteroid' && killerTeam === 'player') {
      this.#addScore(
        entity.has('homing') ? SCORE_HOMING_ASTEROID : SCORE_ASTEROID,
      );
    }
  }

  #addScore(delta) {
    this.score += delta;
    this.dispatchEvent(
      new CustomEvent('scoreChanged', {
        detail: { score: this.score, delta },
      }),
    );
  }

  #tickRespawns(dt) {
    const waiting = [];

    for (const entry of this.#respawns) {
      entry.timer -= dt;

      if (entry.timer > 0) {
        waiting.push(entry);
        continue;
      }

      const ship = this.#spawnShip(entry.team);
      ship.attach('shield', new Effect('shield', SPAWN_SHIELD));
    }

    this.#respawns = waiting;
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

  #spawnShip(team) {
    const isPlayer = team === 'player';
    const ship = new Ship({
      pos: this.#safePosition(28, 200),
      angle: this.#rand() * Math.PI * 2,
      team,
      controller: isPlayer ? playerController : enemyController,
      ...(isPlayer ? {} : { maxHp: 60, maxSpeed: 130, fireCooldown: 1.2 }),
    });

    this.world.spawn(ship);
    if (isPlayer) this.player = ship;
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
      rand: this.#rand,
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
