import { Entity } from './entity.js';

/**
 * Pickup: стоїть на місці, колізиться, але НЕ корабель. Він нічого не вміє
 * сам — лише називає ефект (`type` з EFFECT_TYPES). Колізійна система при
 * дотику створює відповідний компонент і причіплює його до корабля.
 */
export class Pickup extends Entity {
  constructor({ pos, type, ttl = 15 }) {
    super({ kind: 'pickup', pos, radius: 16 });
    this.type = type;
    this.ttl = ttl;
    this.wraps = false;
  }
}
