import { Vector2, wrapAngle } from './vector.js';

/**
 * Компоненти — незалежні шматочки поведінки, які можна причепити до БУДЬ-ЯКОЇ
 * сутності: `entity.attach(name, component)`. Контракт один:
 *
 *   component.update?.(entity, dt, world)
 *
 * Entity.update викликає його щокроку. Класів-спадкоємців для цього не потрібно.
 */

/**
 * Homing: повертає вектор швидкості в бік найближчої цілі, зберігаючи модуль
 * швидкості. Не знає, чи він на кулі, чи на астероїді — лише читає/пише
 * `entity.pos` та `entity.vel`.
 */
export class Homing {
  constructor({
    targetKinds,
    turnRate = 2,
    range = Infinity,
    accepts = () => true,
  }) {
    this.targetKinds = targetKinds;
    this.turnRate = turnRate; // рад/с
    this.range = range;
    this.accepts = accepts; // фільтр цілей (наприклад, "не своя команда")
  }

  update(entity, dt, world) {
    const target = this.#pickTarget(entity, world);
    if (!target) return;

    const speed = entity.vel.length();
    if (speed === 0) return;

    const current = entity.vel.angle();
    const wanted = target.pos.sub(entity.pos).angle();
    const maxTurn = this.turnRate * dt;
    const turn = Math.max(
      -maxTurn,
      Math.min(maxTurn, wrapAngle(wanted - current)),
    );

    entity.vel = Vector2.fromAngle(current + turn, speed);
  }

  #pickTarget(entity, world) {
    let best = null;
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

/**
 * Тимчасовий ефект (щит, rapid fire, homing-постріли). Це "поведінка як дані":
 * компонент має ім'я, залишок часу та довільні параметри, а той, хто його
 * читає (Ship.fire, Ship.takeDamage), перевіряє наявність за ім'ям.
 */
export class Effect {
  constructor(name, duration, params = {}) {
    this.name = name;
    this.duration = duration;
    this.remaining = duration;
    Object.assign(this, params);
  }

  update(entity, dt) {
    this.remaining -= dt;
    if (this.remaining <= 0) entity.detach(this.name);
  }
}

/** Що видає кожен тип pickup-а. Фабрики, щоб кожен підбір давав свіжий таймер. */
export const EFFECT_TYPES = {
  shield: () => new Effect('shield', 6),
  rapidFire: () => new Effect('rapidFire', 8, { cooldownScale: 0.35 }),
  homingShots: () => new Effect('homingShots', 8),
};
