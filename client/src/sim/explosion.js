import { Entity } from './entity.js';
import { Vector2 } from './vector.js';

const TAU = Math.PI * 2;
export const EXPLOSION_LIFETIME = 0.8;

/**
 * Вибух: коротко живе і несе набір частинок. radius = 0, тому колізії його
 * ігнорують (див. findCollisions). Частинки — прості дані, а не окремі сутності:
 * їх сотні, а кожній окремий id, Map-запис і sweep були б зайвими.
 */
export class Explosion extends Entity {
  constructor({ pos, size = 30, rand = Math.random }) {
    super({ kind: 'explosion', pos, radius: 0 });
    this.wraps = false;
    this.ttl = EXPLOSION_LIFETIME;
    this.lifetime = EXPLOSION_LIFETIME;

    const count = Math.round(12 + size / 2);
    this.particles = Array.from({ length: count }, () => ({
      pos,
      vel: Vector2.fromAngle(rand() * TAU, 40 + rand() * 220),
      size: 1.5 + rand() * (2 + size / 12),
    }));
  }

  behave(dt) {
    const drag = Math.exp(-3 * dt);

    for (const particle of this.particles) {
      particle.pos = particle.pos.add(particle.vel.scale(dt));
      particle.vel = particle.vel.scale(drag);
    }
  }
}
