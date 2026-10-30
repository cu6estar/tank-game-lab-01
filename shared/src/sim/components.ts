import type { Entity, EntityKind } from './entity.ts';
import { Vector2, wrapAngle } from './vector.ts';
import type { World } from './world.ts';

/**
 * Компоненти — незалежні шматочки поведінки, які можна причепити до БУДЬ-ЯКОЇ
 * сутності: `entity.attach(name, component)`. Контракт один:
 *
 *   component.update?.(entity, dt, world)
 *
 * Entity.update викликає його щокроку. Класів-спадкоємців для цього не потрібно.
 */
export interface Component {
  update?(entity: Entity<EntityKind>, dt: number, world: World): void;
}

/** Порядок типів pickup-ів у протоколі (індекс = код) — він же імена ефектів. */
export const PICKUP_TYPES = ['shield', 'rapidFire', 'homingShots'] as const;
export type PickupType = (typeof PICKUP_TYPES)[number];

export interface HomingOptions {
  readonly targetKinds: readonly EntityKind[];
  readonly turnRate?: number;
  readonly range?: number;
  readonly accepts?: (target: Entity<EntityKind>) => boolean;
}

/**
 * Homing: повертає вектор швидкості в бік найближчої цілі, зберігаючи модуль
 * швидкості. Не знає, чи він на кулі, чи на астероїді — лише читає/пише
 * `entity.pos` та `entity.vel`.
 */
export class Homing implements Component {
  readonly targetKinds: readonly EntityKind[];
  readonly turnRate: number; // рад/с
  readonly range: number;
  readonly accepts: (target: Entity<EntityKind>) => boolean; // фільтр цілей

  constructor({ targetKinds, turnRate = 2, range = Infinity, accepts = () => true }: HomingOptions) {
    this.targetKinds = targetKinds;
    this.turnRate = turnRate;
    this.range = range;
    this.accepts = accepts;
  }

  update(entity: Entity<EntityKind>, dt: number, world: World): void {
    const target = this.#pickTarget(entity, world);
    if (!target) return;

    const speed = entity.vel.length();
    if (speed === 0) return;

    const current = entity.vel.angle();
    const wanted = target.pos.sub(entity.pos).angle();
    const maxTurn = this.turnRate * dt;
    const turn = Math.max(-maxTurn, Math.min(maxTurn, wrapAngle(wanted - current)));

    entity.vel = Vector2.fromAngle(current + turn, speed);
  }

  #pickTarget(entity: Entity<EntityKind>, world: World): Entity<EntityKind> | null {
    let best: Entity<EntityKind> | null = null;
    let bestDistSq = this.range * this.range;

    for (const kind of this.targetKinds) {
      for (const candidate of world.ofKind(kind)) {
        if (candidate === entity || !this.accepts(candidate)) continue;

        const distSq = entity.pos.distanceSqTo(candidate.pos);
        if (distSq < bestDistSq) {
          best = candidate;
          bestDistSq = distSq;
        }
      }
    }

    return best;
  }
}

export interface EffectOptions {
  /** Множник перезарядки (rapid fire < 1). */
  readonly cooldownScale?: number;
}

/**
 * Тимчасовий ефект (щит, rapid fire, homing-постріли). Це "поведінка як дані":
 * компонент має ім'я, залишок часу та параметри, а той, хто його
 * читає (Ship.fire, Ship.takeDamage), перевіряє наявність за ім'ям.
 */
export class Effect implements Component {
  readonly name: PickupType;
  readonly duration: number;
  remaining: number;
  readonly cooldownScale: number;

  constructor(name: PickupType, duration: number, { cooldownScale = 1 }: EffectOptions = {}) {
    this.name = name;
    this.duration = duration;
    this.remaining = duration;
    this.cooldownScale = cooldownScale;
  }

  update(entity: Entity<EntityKind>, dt: number): void {
    this.remaining -= dt;
    if (this.remaining <= 0) entity.detach(this.name);
  }
}

/** Які компоненти бувають і чим вони є: `attach('shield', …)` приймає лише Effect. */
export interface ComponentMap {
  shield: Effect;
  rapidFire: Effect;
  homingShots: Effect;
  homing: Homing;
}
export type ComponentName = keyof ComponentMap;
export const COMPONENT_NAMES = ['shield', 'rapidFire', 'homingShots', 'homing'] as const satisfies readonly ComponentName[];

/** Що видає кожен тип pickup-а. Фабрики, щоб кожен підбір давав свіжий таймер. */
export const EFFECT_TYPES = {
  shield: () => new Effect('shield', 6),
  rapidFire: () => new Effect('rapidFire', 8, { cooldownScale: 0.35 }),
  homingShots: () => new Effect('homingShots', 8),
} satisfies Record<PickupType, () => Effect>;
