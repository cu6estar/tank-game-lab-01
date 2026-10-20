import { Vector2 } from './vector.js';

/**
 * Базова сутність світу. Це ЄДИНИЙ рівень, від якого щось успадковується:
 * Ship, Bullet, Asteroid, Pickup, Explosion extends Entity — і все.
 *
 * Додаткові здібності (homing, щит, rapid fire) не успадковуються, а
 * "причіплюються" як компоненти: attach / detach / has / getComponent.
 */
export class Entity {
  // id видає СВІТ при spawn (World.#nextId), а не глобальний лічильник:
  // два світи (дві кімнати на сервері, сервер і клієнт) нумерують сутності
  // незалежно й однаково, якщо роблять однакові дії.
  #id = 0;
  #components = new Map();

  constructor({
    kind,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 0,
  }) {
    this.kind = kind;
    this.pos = pos;
    this.prevPos = pos; // стан попереднього кроку — для інтерполяції в рендері
    this.vel = vel;
    this.angle = angle;
    this.prevAngle = angle;
    this.radius = radius;
    this.alive = true;
    this.ttl = Infinity; // час життя в секундах; Infinity = живе, доки не вб'ють
    this.wraps = true; // чи "загортається" через краї арени
    this.world = null; // виставляє World.spawn, скидає sweep
  }

  get id() {
    return this.#id;
  }

  /** Лише для World.spawn: id приватний, тож змінити його ззовні не можна. */
  static assignId(entity, id) {
    entity.#id = id;
  }

  /**
   * Один крок симуляції (шаблонний метод). Підкласи НЕ перевизначають update,
   * а лише `behave` (власна логіка) і `snapshot` (якщо мають свій стан для інтерполяції).
   */
  update(dt, world) {
    this.snapshot();
    this.behave(dt, world);

    for (const component of this.#components.values()) {
      component.update?.(this, dt, world);
    }

    this.pos = this.pos.add(this.vel.scale(dt));

    this.ttl -= dt;
    if (this.ttl <= 0) this.kill();
  }

  /** Запам'ятати стан до зміни — рендер інтерполює між prev* і поточним. */
  snapshot() {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Хук для логіки конкретного типу сутності. */
  behave() {}

  kill() {
    this.alive = false;
  }

  // --- компоненти (композиція) ---

  attach(name, component) {
    this.#components.set(name, component);
    return this;
  }

  detach(name) {
    return this.#components.delete(name);
  }

  has(name) {
    return this.#components.has(name);
  }

  getComponent(name) {
    return this.#components.get(name);
  }

  *eachComponent() {
    yield* this.#components;
  }
}
