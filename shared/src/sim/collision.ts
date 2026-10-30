import { assertNever } from '../assert-never.ts';
import { EFFECT_TYPES } from './components.ts';
import type { Asteroid } from './asteroid.ts';
import type { Bullet } from './bullet.ts';
import type { Team } from './entity.ts';
import type { SimEntity } from './entities.ts';
import { Explosion } from './explosion.ts';
import type { Pickup } from './pickup.ts';
import type { Ship } from './ship.ts';
import type { World, WorldEvents } from './world.ts';

const ASTEROID_RAM_DAMAGE = 25;

/**
 * Детекція коло-коло. Наївний O(n²): для кількох десятків сутностей цього
 * досить. radius <= 0 (вибухи) в колізіях не бере участі.
 *
 * Створює масив на кожен виклик — для навчальної гри прийнятно; якщо це
 * стане вузьким місцем, систему можна підмінити (World.collisionSystem).
 */
export function findCollisions(entities: Iterable<SimEntity>): [SimEntity, SimEntity][] {
  const solid: SimEntity[] = [];
  for (const entity of entities) {
    if (entity.alive && entity.radius > 0) solid.push(entity);
  }

  const pairs: [SimEntity, SimEntity][] = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i];
      const b = solid[j];
      if (!a || !b) continue; // недосяжно: i, j < length (потрібно для noUncheckedIndexedAccess)
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
function destroy(world: World, entity: SimEntity, killerTeam: Team | null = null): void {
  entity.kill();
  world.spawn(new Explosion({ pos: entity.pos, size: entity.radius, rand: world.rand }));
  world.emit('exploded', {
    entity,
    kind: entity.kind,
    team: entity.team,
    pos: entity.pos,
    killerTeam,
  });
}

/** Влучання: чи завдано шкоди, чи її погасив щит ('blocked'). */
function reportHit(
  world: World,
  target: SimEntity,
  { team, damage, blocked, pos }: Omit<WorldEvents['hit'], 'kind'>,
): void {
  world.emit('hit', { kind: target.kind, team, damage, blocked, pos });
}

function asteroidBullet(asteroid: Asteroid, bullet: Bullet, world: World): void {
  bullet.kill();
  const killed = asteroid.takeDamage(bullet.damage);
  reportHit(world, asteroid, {
    team: bullet.team,
    damage: bullet.damage,
    blocked: false,
    pos: bullet.pos,
  });
  if (killed) destroy(world, asteroid, bullet.team);
}

function asteroidShip(asteroid: Asteroid, ship: Ship, world: World): void {
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
}

function bulletShip(bullet: Bullet, ship: Ship, world: World): void {
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
}

function pickupShip(pickup: Pickup, ship: Ship, world: World): void {
  const effect = EFFECT_TYPES[pickup.type]();
  ship.attach(effect.name, effect);
  pickup.kill();
  world.emit('pickup', { type: pickup.type, team: ship.team, pos: pickup.pos });
}

/**
 * Обробка пари. Спершу впорядковуємо за назвою виду (алфавіт), щоб (куля, корабель)
 * і (корабель, куля) обробляла та сама гілка; далі switch по `first.kind` звужує
 * тип, а `default` з never гарантує, що новий вид сутності не буде забутий.
 */
function collide(a: SimEntity, b: SimEntity, world: World): void {
  const [first, second] = a.kind <= b.kind ? [a, b] : [b, a];

  switch (first.kind) {
    case 'asteroid':
      if (second.kind === 'bullet') asteroidBullet(first, second, world);
      else if (second.kind === 'ship') asteroidShip(first, second, world);
      return;
    case 'bullet':
      if (second.kind === 'ship') bulletShip(first, second, world);
      return;
    case 'pickup':
      if (second.kind === 'ship') pickupShip(first, second, world);
      return;
    case 'explosion': // radius = 0: у колізіях не бере участі
    case 'ship': // пара (ship, ship) не має наслідків
      return;
    default:
      return assertNever(first, 'kind');
  }
}

/** Система колізій за замовчуванням: знайти пари і розкидати по обробниках. */
export function resolveCollisions(world: World): void {
  for (const [a, b] of findCollisions(world)) {
    // Одна з сутностей могла загинути від попередньої пари в цьому ж проході.
    if (!a.alive || !b.alive) continue;
    collide(a, b, world);
  }
}
