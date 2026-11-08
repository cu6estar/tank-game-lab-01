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
 * 2D-вектор. Арифметичні методи (`add`, `scale`, …) ЧИСТІ: повертають новий
 * вектор і нічого не мутують — зручно й безпечно для разових обчислень.
 *
 * Окремо є кілька in-place методів (`set`, `copyFrom`, `addScaled`,
 * `scaleBy`) з суфіксом-дією: вони мутують `this` і повертають його. Їх
 * використовує лише гарячий шлях кроку (integrate кожної сутності щокадру),
 * щоб не створювати по два вектори на сутність за кадр. Поведінка та сама —
 * ті самі операції з float, тому хеш стану не змінюється. Поля вже не
 * readonly саме заради цих методів; поза гарячим шляхом мутувати не треба.
 */
export class Vector2 {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(cos(angle) * length, sin(angle) * length);
  }

  // --- in-place (лише гарячий шлях): мутують this, повертають this ---

  /** Записати координати. */
  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  /** Скопіювати з іншого вектора. */
  copyFrom(v: Vector2): this {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  /** this += v·k. Те саме, що this = this.add(v.scale(k)), але без алокацій. */
  addScaled(v: Vector2, k: number): this {
    this.x += v.x * k;
    this.y += v.y * k;
    return this;
  }

  /** this *= k. */
  scaleBy(k: number): this {
    this.x *= k;
    this.y *= k;
    return this;
  }

  /** Окрема копія (для prevPos, щоб мутація pos її не зачіпала). */
  clone(): Vector2 {
    return new Vector2(this.x, this.y);
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
