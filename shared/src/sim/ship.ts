import { seqTag, ZERO_SEQ } from '../brand.ts';
import type { Seq } from '../brand.ts';
import { exp } from '../math.ts';
import { Bullet } from './bullet.ts';
import { Homing } from './components.ts';
import { IDLE } from './controllers.ts';
import type { Controller } from './controllers.ts';
import { Entity } from './entity.ts';
import type { Team } from './entity.ts';
import { Vector2 } from './vector.ts';
import type { World } from './world.ts';

// Фізика перенесена з лаби 1 (integrateTank) без змін у відчуттях.
const ACCELERATION = 650;
const REVERSE_ACCELERATION = 450;
// 0.88 за кадр при 60 Гц, виражено через швидкість загасання: v *= exp(-k·dt).
// (Math.pow дає різні біти в різних рушіях; наш exp — однакові.)
// Константа записана ЛІТЕРАЛОМ: Math.log теж може відрізнятися між рушіями.
const FRICTION_RATE = 7.670002290593093; // = -60·ln(0.88)
const TURN_SPEED = Math.PI * 1.5;
const TURRET_TURN_SPEED = Math.PI * 2;

const MUZZLE_DISTANCE = 38; // довжина ствола в рендері
const BULLET_SPEED = 560;

/**
 * Корабель (танк) з лаби 1. Один рівень успадкування: Ship extends Entity.
 *
 * Керування віддане `controller`-у (функція `(ship, world) => intent`), тому
 * один і той самий клас — і гравець, і ворог. Стрільба — окремий метод fire().
 */
export interface ShipInit {
  readonly pos: Vector2;
  readonly angle?: number;
  readonly team: Team;
  readonly controller?: Controller | null;
  readonly maxHp?: number;
  readonly maxSpeed?: number;
  readonly fireCooldown?: number;
}

export class Ship extends Entity<'ship'> {
  #hp: number;
  controller: Controller | null;
  readonly maxHp: number;
  readonly maxSpeed: number;
  readonly fireCooldown: number;
  cooldown = 0;
  // seq ввода, який зараз виконується (для мітки кулі; у ворогів завжди 0)
  inputSeq: Seq = ZERO_SEQ;
  turretAngle: number;
  prevTurretAngle: number;

  constructor({
    pos,
    angle = 0,
    team,
    controller = null,
    maxHp = 100,
    maxSpeed = 220,
    fireCooldown = 0.35,
  }: ShipInit) {
    super({ kind: 'ship', pos, angle, radius: 28 });
    this.team = team;
    this.controller = controller;
    this.maxHp = maxHp;
    this.maxSpeed = maxSpeed;
    this.fireCooldown = fireCooldown;
    this.turretAngle = angle;
    this.prevTurretAngle = angle;
    this.#hp = maxHp;
  }

  /** HP можна лише читати: змінити їх можна тільки через takeDamage(). */
  get hp(): number {
    return this.#hp;
  }

  override snapshot(): void {
    super.snapshot();
    this.prevTurretAngle = this.turretAngle;
  }

  override behave(dt: number, world: World): void {
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
      this.vel = this.vel.scale(exp(-FRICTION_RATE * dt));
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
  fire(): boolean {
    if (this.cooldown > 0) return false;

    const rapid = this.getComponent('rapidFire');
    this.cooldown = this.fireCooldown * (rapid?.cooldownScale ?? 1);

    const direction = Vector2.fromAngle(this.turretAngle);
    const bullet = new Bullet({
      pos: this.pos.add(direction.scale(MUZZLE_DISTANCE)),
      vel: this.vel.add(direction.scale(BULLET_SPEED)),
      owner: this,
      tag: seqTag(this.inputSeq),
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

    const { world } = this;
    if (!world) return false; // корабель поза світом не стріляє
    world.spawn(bullet);
    world.emit('fired', { team: this.team, pos: bullet.pos });
    return true;
  }

  /** Щит робить корабель невразливим. */
  get invulnerable(): boolean {
    return this.has('shield');
  }

  /** Повертає true, якщо саме цей удар знищив корабель. */
  takeDamage(amount: number): boolean {
    if (!this.alive || this.invulnerable) return false;

    this.#hp = Math.max(0, this.#hp - amount);
    if (this.#hp > 0) return false;

    this.kill();
    return true;
  }
}
