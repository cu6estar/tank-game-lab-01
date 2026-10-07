import { EFFECT_TYPES } from './components.js';
import { Explosion } from './explosion.js';

const ASTEROID_RAM_DAMAGE = 25;

/**
 * Детекція коло-коло. Наївний O(n²): для кількох десятків сутностей цього
 * досить. radius <= 0 (вибухи) в колізіях не бере участі.
 *
 * Створює масив на кожен виклик — для навчальної гри прийнятно; якщо це
 * стане вузьким місцем, систему можна підмінити (World.collisionSystem).
 */
export function findCollisions(entities) {
  const solid = [];
  for (const entity of entities) {
    if (entity.alive && entity.radius > 0) solid.push(entity);
  }

  const pairs = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i];
      const b = solid[j];
      const reach = a.radius + b.radius;

      if (a.pos.distanceSqTo(b.pos) <= reach * reach) pairs.push([a, b]);
    }
  }

  return pairs;
}

/** Знищити сутність: позначити мертвою, вибух із частинок, подія для правил гри. */
function destroy(world, entity, killerTeam = null) {
  entity.kill();
  world.spawn(new Explosion({ pos: entity.pos, size: entity.radius }));
  world.emit({ type: 'destroyed', entity, killerTeam });
}

/**
 * Обробники за парою видів. Ключ — назви видів в алфавітному порядку,
 * щоб (куля, корабель) і (корабель, куля) обробляла та сама функція.
 */
const HANDLERS = new Map([
  [
    'asteroid|bullet',
    (asteroid, bullet, world) => {
      bullet.kill();
      if (asteroid.takeDamage(bullet.damage))
        destroy(world, asteroid, bullet.team);
    },
  ],
  [
    'asteroid|ship',
    (asteroid, ship, world) => {
      // Астероїд розбивається об корабель; щит гасить удар повністю.
      destroy(world, asteroid);
      if (ship.takeDamage(ASTEROID_RAM_DAMAGE)) destroy(world, ship);
    },
  ],
  [
    'bullet|ship',
    (bullet, ship, world) => {
      if (bullet.team === ship.team) return; // по своїх не б'ємо
      bullet.kill();
      if (ship.takeDamage(bullet.damage)) destroy(world, ship, bullet.team);
    },
  ],
  [
    'pickup|ship',
    (pickup, ship, world) => {
      const effect = EFFECT_TYPES[pickup.type]();
      ship.attach(effect.name, effect);
      pickup.kill();
      world.emit({ type: 'pickup', entity: pickup, ship });
    },
  ],
]);

/** Система колізій за замовчуванням: знайти пари і розкидати по обробниках. */
export function resolveCollisions(world) {
  for (const [a, b] of findCollisions(world)) {
    // Одна з сутностей могла загинути від попередньої пари в цьому ж проході.
    if (!a.alive || !b.alive) continue;

    const [first, second] = a.kind <= b.kind ? [a, b] : [b, a];
    HANDLERS.get(`${first.kind}|${second.kind}`)?.(first, second, world);
  }
}
