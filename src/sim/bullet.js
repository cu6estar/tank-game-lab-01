import { Entity } from './entity.js';

/**
 * Куля. Час життя (`ttl`) рахує сам Entity.update; коли він спливає — куля
 * позначається мертвою, а World.step видаляє її в кінці кроку.
 */
export class Bullet extends Entity {
  constructor({ pos, vel, owner, damage = 20, ttl = 1.6 }) {
    super({ kind: 'bullet', pos, vel, angle: vel.angle(), radius: 4 });
    this.ownerId = owner.id;
    this.team = owner.team;
    this.damage = damage;
    this.ttl = ttl;
  }
}
