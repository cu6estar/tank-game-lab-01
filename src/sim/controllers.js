import { wrapAngle } from './vector.js';

const IDLE = Object.freeze({
  throttle: 0,
  turn: 0,
  turretTurn: 0,
  fire: false,
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Контролер гравця: читає клавіші з `world.inputs` (той самий об'єкт, що
 * передали у `world.step(dt, inputs)`). Стрільба сюди не входить —
 * вона йде через keydown-слухач у main.js (див. README про `this`).
 */
export function playerController(ship, world) {
  const input = world.inputs;
  if (!input) return IDLE;

  const axis = (positive, negative) =>
    (input.isDown(positive) ? 1 : 0) - (input.isDown(negative) ? 1 : 0);

  return {
    throttle: axis('ArrowUp', 'ArrowDown'),
    turn: axis('ArrowRight', 'ArrowLeft'),
    turretTurn: axis('KeyX', 'KeyZ'),
    fire: false,
  };
}

/** Простий ворожий AI: розвертається до найближчого ворога, тримає дистанцію, стріляє. */
export function enemyController(ship, world) {
  let target = null;
  let bestDistSq = Infinity;

  for (const other of world.ofKind('ship')) {
    if (other.team === ship.team) continue;

    const distSq = ship.pos.distanceSqTo(other.pos);
    if (distSq < bestDistSq) {
      target = other;
      bestDistSq = distSq;
    }
  }

  if (!target) return IDLE;

  const toTarget = target.pos.sub(ship.pos);
  const distance = toTarget.length();
  const wanted = toTarget.angle();
  const hullError = wrapAngle(wanted - ship.angle);
  const turretError = wrapAngle(wanted - ship.turretAngle);

  return {
    throttle: distance > 320 ? 1 : distance < 180 ? -0.6 : 0,
    // Пропорційне керування: біля цілі повертаємо повільніше, без тремтіння.
    turn: clamp(hullError * 3, -1, 1),
    turretTurn: clamp(turretError * 4, -1, 1),
    fire: Math.abs(turretError) < 0.1 && distance < 520,
  };
}
