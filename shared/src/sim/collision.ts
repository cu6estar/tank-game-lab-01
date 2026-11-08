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

/** Відфільтрувати «тверді» сутності в порядку світу (radius <= 0 — поза колізіями). */
function solidEntities(entities: Iterable<SimEntity>): SimEntity[] {
  const solid: SimEntity[] = [];
  for (const entity of entities) {
    if (entity.alive && entity.radius > 0) solid.push(entity);
  }
  return solid;
}

/**
 * Наївний O(n²): кожна пара з кожною. Лишаємо як еталон поведінки — сеточна
 * версія мусить давати ТОЙ САМИЙ список пар (див. мікробенч і тест рівності).
 */
export function findCollisionsNaive(entities: Iterable<SimEntity>): [SimEntity, SimEntity][] {
  const solid = solidEntities(entities);
  const pairs: [SimEntity, SimEntity][] = [];
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i];
      const b = solid[j];
      if (!a || !b) continue; // недосяжно: i, j < length (для noUncheckedIndexedAccess)
      const reach = a.radius + b.radius;
      if (a.pos.distanceSqTo(b.pos) <= reach * reach) pairs.push([a, b]);
    }
  }
  return pairs;
}

// Зсув для ключа комірки: координати можуть бути від'ємними (мікробенч),
// а в грі — у [0, розмір). 1<<15 з запасом перекриває обидва випадки.
const CELL_BIAS = 1 << 15;
const cellKey = (cx: number, cy: number): number => (cx + CELL_BIAS) * (CELL_BIAS * 2) + (cy + CELL_BIAS);

/**
 * Рівномірна просторова сітка замість O(n²). Розмір комірки = 2·maxRadius,
 * тож дві сутності, що торкаються (відстань <= r_a+r_b <= 2·maxRadius),
 * завжди в сусідніх комірках — досить перевірити околицю 3×3.
 *
 * Пари повертаються ВІДСОРТОВАНИМИ за індексами (i, j) у порядку світу —
 * рівно так, як їх видає наївний цикл. Тому порядок обробки (а отже й хеш
 * стану) не змінюється: сітка лише швидша, не «інша».
 */
export function findCollisions(entities: Iterable<SimEntity>): [SimEntity, SimEntity][] {
  const solid = solidEntities(entities);
  const n = solid.length;
  if (n < 2) return [];

  let maxRadius = 0;
  for (const e of solid) if (e.radius > maxRadius) maxRadius = e.radius;
  const cell = Math.max(1, maxRadius * 2);

  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const e = solid[i];
    if (!e) continue;
    const key = cellKey(Math.floor(e.pos.x / cell), Math.floor(e.pos.y / cell));
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }

  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = solid[i];
    if (!a) continue;
    const cx = Math.floor(a.pos.x / cell);
    const cy = Math.floor(a.pos.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const bucket = grid.get(cellKey(gx, gy));
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue; // кожну пару рахуємо один раз (j > i)
          const b = solid[j];
          if (!b) continue;
          const reach = a.radius + b.radius;
          if (a.pos.distanceSqTo(b.pos) <= reach * reach) pairs.push([i, j]);
        }
      }
    }
  }

  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]); // той самий порядок, що й O(n²)

  const result: [SimEntity, SimEntity][] = [];
  for (const [i, j] of pairs) {
    const a = solid[i];
    const b = solid[j];
    if (a && b) result.push([a, b]);
  }
  return result;
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
