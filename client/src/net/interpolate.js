import { wrapAngle } from '@tank/shared/sim/vector.js';

/** Лінійна інтерполяція координати на тороїдальній арені (через край — найкоротшим шляхом). */
export function lerpWrapped(from, to, alpha, size) {
  let delta = to - from;
  if (delta > size / 2) delta -= size;
  else if (delta < -size / 2) delta += size;
  const value = from + delta * alpha;
  return ((value % size) + size) % size;
}

export const lerpAngle = (from, to, alpha) =>
  from + wrapAngle(to - from) * alpha;

const byId = (list) => new Map(list.map((e) => [e.id, e]));

/**
 * Сутності між двома знімками. Правила появи/зникнення:
 *   — є в `a` і `b`  → інтерполюємо;
 *   — лише в `a`     → зникла між знімками: малюємо в стані `a` (зникне, коли
 *                      час перейде на наступний інтервал);
 *   — лише в `b`     → з'явилась між знімками: НЕ малюємо, поки час не дійде до b
 *                      (тоді вона стане "a" і з'явиться на своєму місці, без стрибка).
 */
export function interpolateList(
  listA,
  listB,
  alpha,
  { width, height },
  fields = {},
) {
  const mapB = byId(listB);
  const result = [];

  for (const a of listA) {
    const b = mapB.get(a.id);
    if (!b || alpha === 0) {
      result.push({ ...a });
      continue;
    }
    const item = {
      ...b,
      x: lerpWrapped(a.x, b.x, alpha, width),
      y: lerpWrapped(a.y, b.y, alpha, height),
    };
    for (const name of fields.angles ?? [])
      item[name] = lerpAngle(a[name], b[name], alpha);
    result.push(item);
  }
  return result;
}

/** Інтерполяція всього знімка між a і b (подвійні посилання ⇒ повертає a як є). */
export function interpolateSnapshot(a, b, alpha, size) {
  if (a === b || alpha === 0) return a;
  return {
    ...b,
    ships: interpolateList(a.ships, b.ships, alpha, size, {
      angles: ['angle', 'turret'],
    }),
    bullets: interpolateList(a.bullets, b.bullets, alpha, size),
    asteroids: interpolateList(a.asteroids, b.asteroids, alpha, size, {
      angles: ['angle'],
    }),
    pickups: interpolateList(a.pickups, b.pickups, alpha, size),
  };
}
