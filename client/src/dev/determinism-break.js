import { Ship } from '@tank/shared/sim/ship.js';
import { Vector2 } from '@tank/shared/sim/vector.js';

/**
 * ЕКСПЕРИМЕНТ (?break=random): навмисно ламаємо детермінізм ТІЛЬКИ в клієнтській
 * копії симуляції — додаємо Math.random() у фізику корабля.
 *
 * Сервер рахує без шуму, клієнт передбачає з шумом ⇒ після кожного знімка
 * "звірка" знаходить розбіжність, і розмір корекції в netgraph росте разом з
 * кількістю невідтворюваних кроків у буфері вводів (чим більший RTT, тим гірше).
 * Скриншот — у README. Знімається видаленням ?break=random з URL.
 */
export function installRandomBreak(amplitude = 18) {
  if (Ship.prototype.behave.__broken) return;
  const original = Ship.prototype.behave;

  Ship.prototype.behave = function broken(dt, world) {
    original.call(this, dt, world);
    this.vel = this.vel.add(
      new Vector2(
        (Math.random() - 0.5) * amplitude,
        (Math.random() - 0.5) * amplitude,
      ),
    );
  };
  Ship.prototype.behave.__broken = true;
  console.warn(
    '[dev] ?break=random: у передбаченні додано Math.random() — очікуйте великі корекції',
  );
}
