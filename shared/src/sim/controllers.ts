import type { Ship } from './ship.ts';
import { wrapAngle } from './vector.ts';
import type { World } from './world.ts';

/**
 * Намір керування кораблем за один крок. Для гравця осі — цілі −1/0/1 (це
 * гарантує схема протоколу), у AI вони можуть бути дробовими (плавний поворот).
 */
export interface Intent {
  readonly throttle: number;
  readonly turn: number;
  readonly turretTurn: number;
  readonly fire: boolean;
}

/** Хто керує кораблем: (ship, world) → намір. Один тип і для гравця, і для ворога. */
export type Controller = (ship: Ship, world: World) => Intent;

export const IDLE: Intent = Object.freeze({
  throttle: 0,
  turn: 0,
  turretTurn: 0,
  fire: false,
});

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

/** Простий ворожий AI: розвертається до найближчого ворога, тримає дистанцію, стріляє. */
export const enemyController: Controller = (ship, world) => {
  let target: Ship | null = null;
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
};
