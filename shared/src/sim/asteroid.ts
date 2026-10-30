import { createRng } from '../rng.ts';
import { Entity } from './entity.ts';
import { Vector2 } from './vector.ts';

const TAU = Math.PI * 2;
const VERTEX_COUNT = 10;

export interface AsteroidInit {
  readonly pos: Vector2;
  readonly vel: Vector2;
  readonly radius: number;
  readonly spin?: number;
  readonly shapeSeed?: number;
}

/** Астероїд-перешкода. Може отримати компонент 'homing' і стати "переслідувачем". */
export class Asteroid extends Entity<'asteroid'> {
  readonly spin: number; // рад/с, суто візуальне обертання
  hp: number;
  // 16-бітне зерно форми їде в знімку; клієнт відновлює контур із нього сам.
  readonly shapeSeed: number;
  readonly shape: readonly Vector2[];

  constructor({ pos, vel, radius, spin = 0, shapeSeed = 0 }: AsteroidInit) {
    super({ kind: 'asteroid', pos, vel, radius });
    this.spin = spin;
    this.hp = Math.round(radius * 1.2);
    this.shapeSeed = shapeSeed;

    // Нерівний контур: полігон з відхиленнями радіуса, рахується один раз.
    const rand = createRng(shapeSeed);
    this.shape = Array.from({ length: VERTEX_COUNT }, (_, i) => {
      const a = (i / VERTEX_COUNT) * TAU;
      return Vector2.fromAngle(a, radius * (0.8 + rand() * 0.25));
    });
  }

  override behave(dt: number): void {
    this.angle += this.spin * dt;
  }

  /** Повертає true, якщо саме цей удар знищив астероїд. */
  takeDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    if (this.hp > 0) return false;

    this.kill();
    return true;
  }
}
