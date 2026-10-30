import type { EntityId, } from '../brand.ts';
import { UNASSIGNED_ID } from '../brand.ts';
import type { ComponentMap, ComponentName } from './components.ts';
import { COMPONENT_NAMES } from './components.ts';
import { Vector2 } from './vector.ts';
import type { World } from './world.ts';

/** Види сутностей. Це дискримінант: за `kind` tsc знає, який саме клас перед ним. */
export type EntityKind = 'ship' | 'bullet' | 'asteroid' | 'pickup' | 'explosion';

/** Команда: гравець зі слотом N — "pN", вороги — "enemy". Команда не б'є по своїх. */
export type Team = 'enemy' | `p${number}`;

export interface EntityInit<K extends EntityKind> {
  readonly kind: K;
  readonly pos?: Vector2;
  readonly vel?: Vector2;
  readonly angle?: number;
  readonly radius?: number;
}

/**
 * Базова сутність світу. Це ЄДИНИЙ рівень, від якого щось успадковується:
 * Ship, Bullet, Asteroid, Pickup, Explosion extends Entity — і все.
 *
 * Додаткові здібності (homing, щит, rapid fire) не успадковуються, а
 * "причіплюються" як компоненти: attach / detach / has / getComponent.
 * `K` — літеральний тип виду ('ship', 'bullet'…): клас кожного виду фіксує його.
 */
export abstract class Entity<K extends EntityKind> {
  // id видає СВІТ при spawn (World.#nextId), а не глобальний лічильник:
  // два світи (дві кімнати на сервері, сервер і клієнт) нумерують сутності
  // незалежно й однаково, якщо роблять однакові дії.
  #id: EntityId = UNASSIGNED_ID;
  #components: { [N in ComponentName]?: ComponentMap[N] } = {};

  readonly kind: K;
  pos: Vector2;
  prevPos: Vector2; // стан попереднього кроку — для інтерполяції в рендері
  vel: Vector2;
  angle: number;
  prevAngle: number;
  radius: number;
  alive = true;
  ttl = Infinity; // час життя в секундах; Infinity = живе, доки не вб'ють
  wraps = true; // чи "загортається" через краї арени
  world: World | null = null; // виставляє World.spawn, скидає sweep
  /** Команда (кораблі й кулі); у решти — null. */
  team: Team | null = null;

  constructor({ kind, pos = new Vector2(), vel = new Vector2(), angle = 0, radius = 0 }: EntityInit<K>) {
    this.kind = kind;
    this.pos = pos;
    this.prevPos = pos;
    this.vel = vel;
    this.angle = angle;
    this.prevAngle = angle;
    this.radius = radius;
  }

  get id(): EntityId {
    return this.#id;
  }

  /** Лише для World.spawn: id приватний, тож змінити його ззовні не можна. */
  static assignId(entity: Entity<EntityKind>, id: EntityId): void {
    entity.#id = id;
  }

  /**
   * Один крок симуляції (шаблонний метод). Підкласи НЕ перевизначають update,
   * а лише `behave` (власна логіка) і `snapshot` (якщо мають свій стан для інтерполяції).
   */
  update(dt: number, world: World): void {
    this.snapshot();
    this.behave(dt, world);

    for (const name of COMPONENT_NAMES) {
      this.#components[name]?.update?.(this, dt, world);
    }

    this.pos = this.pos.add(this.vel.scale(dt));

    this.ttl -= dt;
    if (this.ttl <= 0) this.kill();
  }

  /** Запам'ятати стан до зміни — рендер інтерполює між prev* і поточним. */
  snapshot(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  /** Хук для логіки конкретного типу сутності. */
  behave(_dt: number, _world: World): void {}

  kill(): void {
    this.alive = false;
  }

  // --- компоненти (композиція) ---

  attach<N extends ComponentName>(name: N, component: ComponentMap[N]): this {
    this.#components[name] = component;
    return this;
  }

  detach(name: ComponentName): boolean {
    const had = this.#components[name] !== undefined;
    delete this.#components[name];
    return had;
  }

  has(name: ComponentName): boolean {
    return this.#components[name] !== undefined;
  }

  getComponent<N extends ComponentName>(name: N): ComponentMap[N] | undefined {
    return this.#components[name];
  }
}
