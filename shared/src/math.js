/**
 * Детермінована математика для симуляції.
 *
 * ПРОБЛЕМА, яку ми справді спіймали: специфікація ECMAScript дозволяє
 * `Math.sin`, `Math.cos`, `Math.pow`… давати "наближений до реалізації"
 * результат. Той самий сценарій у Node 22 і Chrome 141 розійшовся вже на
 * першому кроці (різниця в останньому біті `Math.sin(2.5)`, `Math.cos(0.1)`,
 * `Math.pow(0.88, 3)`). Для передбачення на клієнті й авторитетної симуляції на
 * сервері біт-у-біт збіг — вимога, а не приємний бонус.
 *
 * Базові операції `+ − × ÷` і `Math.sqrt` IEEE-754 вимагає ТОЧНО округлювати,
 * тому на них різниці між рушіями немає. Усе нижче побудовано лише з них:
 * зведення аргументу + многочлен (ряд Тейлора, схема Горнера).
 * Точність ~1e-15 — для гри з запасом, а різниці між рушіями — рівно нуль.
 *
 * Ці функції використовує лише симуляція; рендер і кодек можуть брати Math.*.
 */

const PI = Math.PI;
const TWO_PI = 2 * PI;
const HALF_PI = PI / 2;

const LN2 = 0.6931471805599453;
// ln2 розбитий на "старшу" і "молодшу" частини: k*LN2_HI точний для |k| < 2^11
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;

/** sin на [-π/2, π/2]: ряд Тейлора до x^23 (залишок < 2e-18). */
function sinKernel(x) {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n <= 11; n++) {
    term = (-term * x2) / (2 * n * (2 * n + 1));
    sum += term;
  }
  return sum;
}

export function sin(x) {
  // Зведення до [-π, π]; Math.round — точна операція, без наближень
  let r = x - TWO_PI * Math.round(x / TWO_PI);
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  return sinKernel(r);
}

export function cos(x) {
  return sin(x + HALF_PI);
}

/** atan на [0, 1]: зменшуємо аргумент до |z| ≤ tan(π/8) і сумуємо ряд. */
function atanUnit(a) {
  let offset = 0;
  let z = a;
  if (z > 0.4142135623730951) {
    z = (z - 1) / (z + 1);
    offset = PI / 4;
  }

  const z2 = z * z;
  let power = z;
  let sum = z;
  for (let n = 1; n <= 24; n++) {
    power = -power * z2;
    sum += power / (2 * n + 1);
  }
  return offset + sum;
}

export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;

  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const angle = ay > ax ? HALF_PI - atanUnit(ax / ay) : atanUnit(ay / ax);

  // дзеркалимо в потрібну чверть
  const fromX = x < 0 ? PI - angle : angle;
  return y < 0 ? -fromX : fromX;
}

/** 2^k точно, будуючи біти double (без Math.pow). */
const bits = new DataView(new ArrayBuffer(8));
function pow2(k) {
  bits.setUint32(0, 0, true);
  bits.setUint32(4, ((k + 1023) << 20) >>> 0, true);
  return bits.getFloat64(0, true);
}

export function exp(x) {
  if (x < -700) return 0;
  if (x > 700) return Infinity;

  const k = Math.round(x / LN2);
  const r = x - k * LN2_HI - k * LN2_LO; // |r| ≤ ln2/2
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 13; n++) {
    term = (term * r) / n;
    sum += term;
  }
  return sum * pow2(k);
}

export const hypot = (x, y) => Math.sqrt(x * x + y * y);
