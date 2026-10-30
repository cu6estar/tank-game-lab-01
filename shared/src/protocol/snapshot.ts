import type { Game } from '../sim/game.ts';
import { slotOfTeam } from '../sim/game.ts';
import type { World } from '../sim/world.ts';
import { EVENT, KIND_CODE, NO_SLOT, PICKUP_TYPES } from './constants.ts';
import type {
  Snapshot,
  SnapshotAsteroid,
  SnapshotBullet,
  SnapshotEvent,
  SnapshotPickup,
  SnapshotPlayer,
  SnapshotShip,
} from './types.ts';

/**
 * Знімок стану — звичайний серіалізований об'єкт (plain data), незалежний від
 * формату кодування. JSON-кодек пише його як є, бінарний — пакує в байти.
 * Лише ті поля, що потрібні клієнту: для прив'язки (id), малювання, інтерполяції
 * і (для свого корабля) для передбачення та звірки.
 */
export function buildSnapshot(
  game: Game,
  events: readonly SnapshotEvent[] = [],
): Snapshot {
  const players: SnapshotPlayer[] = [];
  const ships: SnapshotShip[] = [];
  const bullets: SnapshotBullet[] = [];
  const asteroids: SnapshotAsteroid[] = [];
  const pickups: SnapshotPickup[] = [];

  for (const [slot, record] of game.players) {
    players.push({ slot, ack: record.seq, score: record.score });
  }

  for (const entity of game.world) {
    const { id, pos, vel } = entity;

    switch (entity.kind) {
      case 'ship': {
        const slot = slotOfTeam(entity.team);
        ships.push({
          id,
          slot: slot >= 0 ? slot : NO_SLOT,
          x: pos.x,
          y: pos.y,
          vx: vel.x,
          vy: vel.y,
          angle: entity.angle,
          turret: entity.turretAngle,
          hp: entity.hp,
          cooldown: entity.cooldown,
          shield: entity.getComponent('shield')?.remaining ?? 0,
          rapid: entity.getComponent('rapidFire')?.remaining ?? 0,
          homing: entity.getComponent('homingShots')?.remaining ?? 0,
        });
        break;
      }
      case 'bullet': {
        const owner = slotOfTeam(entity.team);
        bullets.push({
          id,
          owner: owner >= 0 ? owner : NO_SLOT,
          x: pos.x,
          y: pos.y,
          vx: vel.x,
          vy: vel.y,
          homing: entity.has('homing'),
          tag: entity.tag,
        });
        break;
      }
      case 'asteroid':
        asteroids.push({
          id,
          x: pos.x,
          y: pos.y,
          angle: entity.angle,
          radius: entity.radius,
          homing: entity.has('homing'),
          seed: entity.shapeSeed,
        });
        break;
      case 'pickup':
        pickups.push({
          id,
          x: pos.x,
          y: pos.y,
          type: PICKUP_TYPES.indexOf(entity.type),
        });
        break;
      case 'explosion':
        // вибухи — суто візуальні, клієнт створює їх сам за подією 'exploded'
        break;
    }
  }

  return { tick: game.tick, players, ships, bullets, asteroids, pickups, events };
}

/** Забрати накопичені події й очистити чергу. */
export interface EventCollector {
  drain(): SnapshotEvent[];
}

/**
 * Підписує на події світу й складає їх у чергу для наступного знімка.
 * Повертає { drain() } — забрати накопичене й очистити.
 */
export function collectEvents(world: World): EventCollector {
  let queue: SnapshotEvent[] = [];
  const MAX = 255; // межа формату (u8 count)

  const push = (event: SnapshotEvent): void => {
    if (queue.length < MAX) queue.push(event);
  };

  const slotOrNone = (team: Parameters<typeof slotOfTeam>[0]): number => {
    const slot = slotOfTeam(team);
    return slot >= 0 ? slot : NO_SLOT;
  };

  world.on('fired', (detail) =>
    push({
      type: EVENT.FIRED,
      a: slotOrNone(detail.team),
      b: 0,
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );
  world.on('hit', (detail) =>
    push({
      type: EVENT.HIT,
      a: KIND_CODE[detail.kind] ?? 0,
      b: detail.blocked ? 1 : 0,
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );
  world.on('exploded', (detail) =>
    push({
      type: EVENT.EXPLODED,
      a: KIND_CODE[detail.kind] ?? 0,
      b: Math.min(255, Math.round(detail.entity.radius)),
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );
  world.on('pickup', (detail) =>
    push({
      type: EVENT.PICKUP,
      a: slotOrNone(detail.team),
      b: Math.max(0, PICKUP_TYPES.indexOf(detail.type)),
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );

  return {
    drain(): SnapshotEvent[] {
      const out = queue;
      queue = [];
      return out;
    },
  };
}
