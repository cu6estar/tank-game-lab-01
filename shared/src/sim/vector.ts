import { atan2, cos, hypot, sin } from '../math.ts';

const TAU = Math.PI * 2;

/**
 * Нормалізує кут у діапазон (-PI, PI].
 * Потрібна для "найкоротшого повороту" (homing, AI башти).
 */
export function wrapAngle(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/**
 * 2D-вектор. Усі методи ЧИСТІ: повертають новий вектор і не мутують
 * ні `this`, ні аргумент (поля — readonly, тож tsc не дасть мутувати). Тому `entity.pos = entity.pos.add(...)` —
 * це заміна посилання, а не зміна старого вектора (це важливо для
 * інтерполяції: `prevPos` лишається незмінним).
 */
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(cos(angle) * length, sin(angle) * length);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  length(): number {
    return hypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : this.scale(1 / len);
  }

  rotate(angle: number): Vector2 {
    const c = cos(angle);
    const s = sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  /** Кут вектора відносно осі X. */
  angle(): number {
    return atan2(this.y, this.x);
  }

  lerp(v: Vector2, t: number): Vector2 {
    return new Vector2(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
    );
  }

  /** Квадрат відстані без створення проміжного вектора (гаряча гілка колізій). */
  distanceSqTo(v: Vector2): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return dx * dx + dy * dy;
  }
}
