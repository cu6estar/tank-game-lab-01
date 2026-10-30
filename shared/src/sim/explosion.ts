import { exp } from '../math.ts';
import type { Rng } from '../rng.ts';
import { Entity } from './entity.ts';
import { Vector2 } from './vector.ts';

const TAU = Math.PI * 2;
export const EXPLOSION_LIFETIME = 0.8;

export interface Particle {
  pos: Vector2;
  vel: Vector2;
  readonly size: number;
}

export interface ExplosionInit {
  readonly pos: Vector2;
  readonly size?: number;
  readonly rand: Rng;
}

/**
 * Вибух: коротко живе і несе набір частинок. radius = 0, тому колізії його
 * ігнорують (див. findCollisions). Частинки — прості дані, а не окремі сутності:
 * їх сотні, а кожній окремий id, Map-запис і sweep були б зайвими.
 */
export class Explosion extends Entity<'explosion'> {
  readonly lifetime = EXPLOSION_LIFETIME;
  readonly particles: Particle[];

  constructor({ pos, size = 30, rand }: ExplosionInit) {
    super({ kind: 'explosion', pos, radius: 0 });
    this.wraps = false;
    this.ttl = EXPLOSION_LIFETIME;

    const count = Math.round(12 + size / 2);
    this.particles = Array.from({ length: count }, () => ({
      pos,
      vel: Vector2.fromAngle(rand() * TAU, 40 + rand() * 220),
      size: 1.5 + rand() * (2 + size / 12),
    }));
  }

  override behave(dt: number): void {
    const drag = exp(-3 * dt);

    for (const particle of this.particles) {
      particle.pos = particle.pos.add(particle.vel.scale(dt));
      particle.vel = particle.vel.scale(drag);
    }
  }
}
