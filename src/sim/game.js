import { World } from './world.js';
import { Ship } from './ship.js';
import { Asteroid } from './asteroid.js';
import { Pickup } from './pickup.js';
import { Effect, EFFECT_TYPES, Homing } from './components.js';
import { enemyController, playerController } from './controllers.js';
import { Vector2 } from './vector.js';

const RESPAWN_DELAY = 2; // секунд
const SPAWN_SHIELD = 2; // секунд невразливості після респауну
const ENEMY_COUNT = 2;
const ASTEROID_TARGET = 6;
const MAX_HOMING_ASTEROIDS = 2;
const ASTEROID_INTERVAL = 2;
const PICKUP_INTERVAL = 8;
const MAX_PICKUPS = 2;

const SCORE_ENEMY = 100;
const SCORE_ASTEROID = 10;
const SCORE_HOMING_ASTEROID = 25;

/**
 * Правила гри поверх World: рахунок, респаун кораблів через 2 с,
 * поповнення астероїдів та pickup-ів. World нічого про це не знає —
 * він лише кидає події (`world.events`), а Game їх читає.
 */
export class Game {
  #respawns = []; // { timer, team }
  #asteroidTimer = 0;
  #pickupTimer = PICKUP_INTERVAL;
  #rand;

  constructor({ width, height, rand = Math.random }) {
    this.#rand = rand;
    this.world = new World({ width, height });
    this.player = null;
    this.score = 0;
  }

  start() {
    this.#spawnShip('player');
    for (let i = 0; i < ENEMY_COUNT; i++) this.#spawnShip('enemy');
    for (let i = 0; i < ASTEROID_TARGET; i++) this.#spawnAsteroid();
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
    this.#handleEvents();
    this.#tickRespawns(dt);
    this.#refill(dt);
  }

  #handleEvents() {
    for (const event of this.world.events) {
      if (event.type !== 'destroyed') continue;

      const { entity, killerTeam } = event;

      if (entity.kind === 'ship') {
        if (entity === this.player) this.player = null;
        this.#respawns.push({ timer: RESPAWN_DELAY, team: entity.team });
        if (killerTeam === 'player') this.score += SCORE_ENEMY;
      } else if (entity.kind === 'asteroid' && killerTeam === 'player') {
        this.score += entity.has('homing')
          ? SCORE_HOMING_ASTEROID
          : SCORE_ASTEROID;
      }
    }
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
    if (asteroids < ASTEROID_TARGET && this.#asteroidTimer <= 0) {
      this.#spawnAsteroid();
      this.#asteroidTimer = ASTEROID_INTERVAL;
    }

    this.#pickupTimer -= dt;
    if (pickups < MAX_PICKUPS && this.#pickupTimer <= 0) {
      this.#spawnPickup();
      this.#pickupTimer = PICKUP_INTERVAL;
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
      this.#countHomingAsteroids() < MAX_HOMING_ASTEROIDS && this.#rand() < 0.3;

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
