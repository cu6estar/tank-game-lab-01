import type { EntityId } from '../brand.ts';
import { Entity } from './entity.ts';
import type { Team } from './entity.ts';
import type { Vector2 } from './vector.ts';

export interface BulletInit {
  readonly pos: Vector2;
  readonly vel: Vector2;
  /** Хто стріляє: потрібні лише id та команда (структурна типізація — годиться і Ship). */
  readonly owner: { readonly id: EntityId; readonly team: Team | null };
  readonly damage?: number;
  readonly ttl?: number;
  readonly tag?: number;
}

/**
 * Куля. Час життя (`ttl`) рахує сам Entity.update; коли він спливає — куля
 * позначається мертвою, а World.step видаляє її в кінці кроку.
 */
export class Bullet extends Entity<'bullet'> {
  readonly ownerId: EntityId;
  readonly damage: number;
  // Мітка: молодші 16 біт seq вводу, що вистрілив. Клієнт за нею впізнає
  // свою передбачену кулю серед куль зі знімка.
  readonly tag: number;

  constructor({ pos, vel, owner, damage = 20, ttl = 1.6, tag = 0 }: BulletInit) {
    super({ kind: 'bullet', pos, vel, angle: vel.angle(), radius: 4 });
    this.ownerId = owner.id;
    this.team = owner.team;
    this.damage = damage;
    this.ttl = ttl;
    this.tag = tag;
  }
}
