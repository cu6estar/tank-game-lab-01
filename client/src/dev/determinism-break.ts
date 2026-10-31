import { Ship } from '@tank/shared/sim/ship.ts';
import { Vector2 } from '@tank/shared/sim/vector.ts';
import type { World } from '@tank/shared/sim/world.ts';

/**
 * ЕКСПЕРИМЕНТ (?break=random): навмисно ламаємо детермінізм ТІЛЬКИ в клієнтській
 * копії симуляції — додаємо Math.random() у фізику корабля. Сервер рахує без
 * шуму, клієнт передбачає з шумом ⇒ після кожного знімка "звірка" знаходить
 * розбіжність, і розмір корекції в netgraph росте. Знімається прибранням ?break.
 */
let installed = false;

export function installRandomBreak(amplitude = 18): void {
  if (installed) return;
  installed = true;
  const original = Ship.prototype.behave;

  Ship.prototype.behave = function broken(this: Ship, dt: number, world: World): void {
    original.call(this, dt, world);
    this.vel = this.vel.add(new Vector2((Math.random() - 0.5) * amplitude, (Math.random() - 0.5) * amplitude));
  };
  console.warn('[dev] ?break=random: у передбаченні додано Math.random() — очікуйте великі корекції');
}
