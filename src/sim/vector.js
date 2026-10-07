const TAU = Math.PI * 2;

/**
 * Нормалізує кут у діапазон (-PI, PI].
 * Потрібна для "найкоротшого повороту" (homing, AI башти).
 */
export function wrapAngle(angle) {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  if (a <= -Math.PI) a += TAU;
  return a;
}

/**
 * 2D-вектор. Усі методи ЧИСТІ: повертають новий вектор і не мутують
 * ні `this`, ні аргумент. Тому `entity.pos = entity.pos.add(...)` —
 * це заміна посилання, а не зміна старого вектора (це важливо для
 * інтерполяції: `prevPos` лишається незмінним).
 */
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2(0, 0) : this.scale(1 / len);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos,
    );
  }

  /** Кут вектора відносно осі X. */
  angle() {
    return Math.atan2(this.y, this.x);
  }

  lerp(v, t) {
    return new Vector2(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
    );
  }

  /** Квадрат відстані без створення проміжного вектора (гаряча гілка колізій). */
  distanceSqTo(v) {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return dx * dx + dy * dy;
  }
}
