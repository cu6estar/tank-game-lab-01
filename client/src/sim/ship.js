import { Entity } from './entity.js';
import { Bullet } from './bullet.js';
import { Homing } from './components.js';
import { Vector2 } from './vector.js';

// Фізика перенесена з лаби 1 (integrateTank) без змін у відчуттях.
const ACCELERATION = 650;
const REVERSE_ACCELERATION = 450;
const FRICTION = 0.88;
const TURN_SPEED = Math.PI * 1.5;
const TURRET_TURN_SPEED = Math.PI * 2;

const MUZZLE_DISTANCE = 38; // довжина ствола в рендері
const BULLET_SPEED = 560;

const IDLE = Object.freeze({ throttle: 0, turn: 0, turretTurn: 0 });

/**
 * Корабель (танк) з лаби 1. Один рівень успадкування: Ship extends Entity.
 *
 * Керування віддане `controller`-у (функція `(ship, world) => intent`), тому
 * один і той самий клас — і гравець, і ворог. Стрільба — окремий метод fire().
 */
export class Ship extends Entity {
  #hp;

  constructor({
    pos,
    angle = 0,
    team,
    controller = null,
    maxHp = 100,
    maxSpeed = 220,
    fireCooldown = 0.35,
  }) {
    super({ kind: 'ship', pos, angle, radius: 28 });
    this.team = team;
    this.controller = controller;
    this.maxHp = maxHp;
    this.maxSpeed = maxSpeed;
    this.fireCooldown = fireCooldown;
    this.cooldown = 0;
    this.turretAngle = angle;
    this.prevTurretAngle = angle;
    this.#hp = maxHp;
  }

  /** HP можна лише читати: змінити їх можна тільки через takeDamage(). */
  get hp() {
    return this.#hp;
  }

  snapshot() {
    super.snapshot();
    this.prevTurretAngle = this.turretAngle;
  }

  behave(dt, world) {
    const intent = this.controller?.(this, world) ?? IDLE;

    this.angle += intent.turn * TURN_SPEED * dt;
    this.turretAngle += intent.turretTurn * TURRET_TURN_SPEED * dt;

    if (intent.throttle !== 0) {
      const acceleration =
        intent.throttle > 0 ? ACCELERATION : REVERSE_ACCELERATION;
      const target = Vector2.fromAngle(
        this.angle,
        this.maxSpeed * intent.throttle,
      );
      const k = Math.min(1, (acceleration * dt) / this.maxSpeed);
      this.vel = this.vel.add(target.sub(this.vel).scale(k));
    } else {
      this.vel = this.vel.scale(Math.pow(FRICTION, dt * 60));
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
    if (intent.fire) this.fire();
  }

  /**
   * Постріл з "носа" (кінця ствола). Куля успадковує швидкість корабля.
   *
   * УВАГА: метод покладається на `this`. Якщо передати `ship.fire` як
   * слухач події без прив'язки — `this` буде не кораблем (див. README).
   */
  fire() {
    if (this.cooldown > 0) return false;

    const rapid = this.getComponent('rapidFire');
    this.cooldown = this.fireCooldown * (rapid?.cooldownScale ?? 1);

    const direction = Vector2.fromAngle(this.turretAngle);
    const bullet = new Bullet({
      pos: this.pos.add(direction.scale(MUZZLE_DISTANCE)),
      vel: this.vel.add(direction.scale(BULLET_SPEED)),
      owner: this,
    });

    if (this.has('homingShots')) {
      // Стрілка тут свідомо: вона бере `this` (корабель) з fire() лексично.
      bullet.attach(
        'homing',
        new Homing({
          targetKinds: ['asteroid', 'ship'],
          turnRate: 3.5,
          range: 380,
          accepts: (target) => target.team !== this.team,
        }),
      );
    }

    this.world.spawn(bullet);
    this.world.emit('fired', { team: this.team, pos: bullet.pos });
    return true;
  }

  /** Щит робить корабель невразливим. */
  get invulnerable() {
    return this.has('shield');
  }

  /** Повертає true, якщо саме цей удар знищив корабель. */
  takeDamage(amount) {
    if (!this.alive || this.invulnerable) return false;

    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp > 0) return false;

    this.kill();
    return true;
  }
}
