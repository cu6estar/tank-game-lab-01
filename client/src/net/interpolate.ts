import type {
  Snapshot,
  SnapshotAsteroid,
  SnapshotBullet,
  SnapshotPickup,
  SnapshotShip,
} from '@tank/shared/protocol/types.ts';
import { wrapAngle } from '@tank/shared/sim/vector.ts';

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Сутність, яку можна інтерполювати за позицією (id для прив'язки). */
interface Positioned {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** Лінійна інтерполяція координати на тороїдальній арені (через край — найкоротшим шляхом). */
export function lerpWrapped(from: number, to: number, alpha: number, size: number): number {
  let delta = to - from;
  if (delta > size / 2) delta -= size;
  else if (delta < -size / 2) delta += size;
  const value = from + delta * alpha;
  return ((value % size) + size) % size;
}

export const lerpAngle = (from: number, to: number, alpha: number): number => from + wrapAngle(to - from) * alpha;

/**
 * Сутності між двома знімками. Правила появи/зникнення:
 *   — є в `a` і `b`  → інтерполюємо (position + `mix` для кутів);
 *   — лише в `a`     → зникла між знімками: малюємо в стані `a`;
 *   — лише в `b`     → з'явилась: НЕ малюємо, поки час не дійде до b.
 *
 * `mix(a, b, base)` домішує поля понад інтерпольовану позицію (кути); за
 * замовчуванням лишає base (для куль/pickup-ів без кутів).
 */
export function interpolateList<T extends Positioned>(
  listA: readonly T[],
  listB: readonly T[],
  alpha: number,
  size: Size,
  mix: (a: T, b: T, base: T) => T = (_a, _b, base) => base,
): T[] {
  const mapB = new Map(listB.map((e) => [e.id, e]));
  const result: T[] = [];

  for (const a of listA) {
    const b = mapB.get(a.id);
    if (!b || alpha === 0) {
      result.push({ ...a });
      continue;
    }
    const base: T = {
      ...b,
      x: lerpWrapped(a.x, b.x, alpha, size.width),
      y: lerpWrapped(a.y, b.y, alpha, size.height),
    };
    result.push(mix(a, b, base));
  }
  return result;
}

/** Інтерполяція всього знімка між a і b (подвійні посилання ⇒ повертає a як є). */
export function interpolateSnapshot(a: Snapshot, b: Snapshot, alpha: number, size: Size): Snapshot {
  if (a === b || alpha === 0) return a;
  return {
    ...b,
    ships: interpolateList<SnapshotShip>(a.ships, b.ships, alpha, size, (pa, pb, base) => ({
      ...base,
      angle: lerpAngle(pa.angle, pb.angle, alpha),
      turret: lerpAngle(pa.turret, pb.turret, alpha),
    })),
    bullets: interpolateList<SnapshotBullet>(a.bullets, b.bullets, alpha, size),
    asteroids: interpolateList<SnapshotAsteroid>(a.asteroids, b.asteroids, alpha, size, (pa, pb, base) => ({
      ...base,
      angle: lerpAngle(pa.angle, pb.angle, alpha),
    })),
    pickups: interpolateList<SnapshotPickup>(a.pickups, b.pickups, alpha, size),
  };
}
