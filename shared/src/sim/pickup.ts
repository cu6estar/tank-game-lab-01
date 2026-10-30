import type { PickupType } from './components.ts';
import { Entity } from './entity.ts';
import type { Vector2 } from './vector.ts';

export interface PickupInit {
  readonly pos: Vector2;
  readonly type: PickupType;
  readonly ttl?: number;
}

/**
 * Pickup: стоїть на місці, колізиться, але НЕ корабель. Він нічого не вміє
 * сам — лише називає ефект (`type` з EFFECT_TYPES). Колізійна система при
 * дотику створює відповідний компонент і причіплює його до корабля.
 */
export class Pickup extends Entity<'pickup'> {
  readonly type: PickupType;

  constructor({ pos, type, ttl = 15 }: PickupInit) {
    super({ kind: 'pickup', pos, radius: 16 });
    this.type = type;
    this.ttl = ttl;
    this.wraps = false;
  }
}
