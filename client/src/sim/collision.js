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

/**
 * Знищити сутність: позначити мертвою, створити вибух із частинок і
 * повідомити світу ('exploded'), щоб звук і правила гри відреагували.
 */
function destroy(world, entity, killerTeam = null) {
  entity.kill();
  world.spawn(new Explosion({ pos: entity.pos, size: entity.radius }));
  world.emit('exploded', {
    entity,
    kind: entity.kind,
    team: entity.team ?? null,
    pos: entity.pos,
    killerTeam,
  });
}

/** Влучання: чи завдано шкоди, чи її погасив щит ('blocked'). */
function reportHit(world, target, { team, damage, blocked, pos }) {
  world.emit('hit', { kind: target.kind, team, damage, blocked, pos });
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
      const killed = asteroid.takeDamage(bullet.damage);
      reportHit(world, asteroid, {
        team: bullet.team,
        damage: bullet.damage,
        blocked: false,
        pos: bullet.pos,
      });
      if (killed) destroy(world, asteroid, bullet.team);
    },
  ],
  [
    'asteroid|ship',
    (asteroid, ship, world) => {
      // Астероїд розбивається об корабель; щит гасить удар повністю.
      const blocked = ship.invulnerable;
      const killed = ship.takeDamage(ASTEROID_RAM_DAMAGE);
      reportHit(world, ship, {
        team: null,
        damage: ASTEROID_RAM_DAMAGE,
        blocked,
        pos: ship.pos,
      });
      destroy(world, asteroid);
      if (killed) destroy(world, ship);
    },
  ],
  [
    'bullet|ship',
    (bullet, ship, world) => {
      if (bullet.team === ship.team) return; // по своїх не б'ємо
      bullet.kill();
      const blocked = ship.invulnerable;
      const killed = ship.takeDamage(bullet.damage);
      reportHit(world, ship, {
        team: bullet.team,
        damage: bullet.damage,
        blocked,
        pos: bullet.pos,
      });
      if (killed) destroy(world, ship, bullet.team);
    },
  ],
  [
    'pickup|ship',
    (pickup, ship, world) => {
      const effect = EFFECT_TYPES[pickup.type]();
      ship.attach(effect.name, effect);
      pickup.kill();
      world.emit('pickup', {
        type: pickup.type,
        team: ship.team,
        pos: pickup.pos,
      });
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
