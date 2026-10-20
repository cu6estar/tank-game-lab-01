import { Entity } from './entity.js';
import { createRng } from '../rng.js';
import { Vector2 } from './vector.js';

const TAU = Math.PI * 2;
const VERTEX_COUNT = 10;

/** Астероїд-перешкода. Може отримати компонент 'homing' і стати "переслідувачем". */
export class Asteroid extends Entity {
  constructor({ pos, vel, radius, spin = 0, shapeSeed = 0 }) {
    super({ kind: 'asteroid', pos, vel, radius });
    this.spin = spin; // рад/с, суто візуальне обертання
    this.hp = Math.round(radius * 1.2);
    // 16-бітне зерно форми їде в знімку; клієнт відновлює контур із нього сам.
    this.shapeSeed = shapeSeed;

    // Нерівний контур: полігон з відхиленнями радіуса, рахується один раз.
    const rand = createRng(shapeSeed);
    this.shape = Array.from({ length: VERTEX_COUNT }, (_, i) => {
      const a = (i / VERTEX_COUNT) * TAU;
      return Vector2.fromAngle(a, radius * (0.8 + rand() * 0.25));
    });
  }

  behave(dt) {
    this.angle += this.spin * dt;
  }

  /** Повертає true, якщо саме цей удар знищив астероїд. */
  takeDamage(amount) {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp > 0) return false;

    this.kill();
    return true;
  }
}
