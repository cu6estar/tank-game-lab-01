import { slotOfTeam } from '../sim/game.js';
import { EVENT, KIND_CODE, NO_SLOT, PICKUP_TYPES } from './constants.js';

/**
 * Знімок стану — звичайний серіалізований об'єкт (plain data), незалежний від
 * формату кодування. JSON-кодек пише його як є, бінарний — пакує в байти.
 *
 *  {
 *    tick,                                    номер кроку сервера
 *    players:   [{ slot, ack, score }],       ack = останній ВИКОНАНИЙ seq гравця
 *    ships:     [{ id, slot, x, y, vx, vy, angle, turret, hp, cooldown, shield, rapid, homing }],
 *    bullets:   [{ id, owner, x, y, vx, vy, homing, tag }],
 *    asteroids: [{ id, x, y, angle, radius, homing, seed }],
 *    pickups:   [{ id, x, y, type }],
 *    events:    [{ type, a, b, x, y }],
 *  }
 *
 * Лише ті поля, що потрібні клієнту: для прив'язки (id), малювання, інтерполяції
 * і (для свого корабля) для передбачення та звірки.
 */
export function buildSnapshot(game, events = []) {
  const snapshot = {
    tick: game.tick,
    players: [],
    ships: [],
    bullets: [],
    asteroids: [],
    pickups: [],
    events,
  };

  for (const [slot, record] of game.players) {
    snapshot.players.push({ slot, ack: record.seq, score: record.score });
  }

  for (const entity of game.world) {
    const { id, pos, vel } = entity;

    switch (entity.kind) {
      case 'ship': {
        const slot = slotOfTeam(entity.team);
        snapshot.ships.push({
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
        snapshot.bullets.push({
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
        snapshot.asteroids.push({
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
        snapshot.pickups.push({
          id,
          x: pos.x,
          y: pos.y,
          type: PICKUP_TYPES.indexOf(entity.type),
        });
        break;
      default:
      // вибухи — суто візуальні, клієнт створює їх сам за подією 'exploded'
    }
  }
  return snapshot;
}

/**
 * Підписує на події світу й складає їх у чергу для наступного знімка.
 * Повертає { drain() } — забрати накопичене й очистити.
 */
export function collectEvents(world) {
  let queue = [];
  const MAX = 255; // межа формату (u8 count)

  const push = (event) => {
    if (queue.length < MAX) queue.push(event);
  };

  world.addEventListener('fired', ({ detail }) =>
    push({
      type: EVENT.FIRED,
      a: slotOfTeam(detail.team) >= 0 ? slotOfTeam(detail.team) : NO_SLOT,
      b: 0,
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );
  world.addEventListener('hit', ({ detail }) =>
    push({
      type: EVENT.HIT,
      a: KIND_CODE[detail.kind] ?? 0,
      b: detail.blocked ? 1 : 0,
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );
  world.addEventListener('exploded', ({ detail }) =>
    push({
      type: EVENT.EXPLODED,
      a: KIND_CODE[detail.kind] ?? 0,
      b: Math.min(255, Math.round(detail.entity.radius)),
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );
  world.addEventListener('pickup', ({ detail }) =>
    push({
      type: EVENT.PICKUP,
      a: slotOfTeam(detail.team) >= 0 ? slotOfTeam(detail.team) : NO_SLOT,
      b: Math.max(0, PICKUP_TYPES.indexOf(detail.type)),
      x: detail.pos.x,
      y: detail.pos.y,
    }),
  );

  return {
    drain() {
      const out = queue;
      queue = [];
      return out;
    },
  };
}
