/**
 * Branded-типи ("мічені" числа). Для JS це просто number, але для tsc —
 * різні типи: `Seq` не можна передати туди, де чекають `Tick` чи `EntityId`,
 * хоч усі три — цілі числа в одному діапазоні. Мітка існує тільки на етапі
 * типів і стирається при запуску (`declare` — теж стирається).
 */
declare const brandTag: unique symbol;
export type Brand<T, Name extends string> = T & { readonly [brandTag]: Name };

/** Номер сутності у світі (u16, 0 = ще не в світі). */
export type EntityId = Brand<number, 'EntityId'>;
/** Номер кроку симуляції (u32). */
export type Tick = Brand<number, 'Tick'>;
/** Порядковий номер вводу клієнта (u32). */
export type Seq = Brand<number, 'Seq'>;

// Єдине місце в проєкті, де число "обертається" в brand: сюди ходять лише
// конструктори нижче, які перед цим перевіряють діапазон.
function brandAs<B extends number>(value: number): B {
  return value as B; // as: brand існує лише на рівні типів, значення те саме
}

function checked(value: number, max: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${what}: очікується ціле 0..${max}, отримано ${value}`);
  }
  return value;
}

export const toEntityId = (value: number): EntityId => brandAs(checked(value, 0xffff, 'EntityId'));
export const toTick = (value: number): Tick => brandAs(checked(value, 0xffffffff, 'Tick'));
export const toSeq = (value: number): Seq => brandAs(checked(value, 0xffffffff, 'Seq'));

export const UNASSIGNED_ID: EntityId = toEntityId(0);
export const ZERO_TICK: Tick = toTick(0);
export const ZERO_SEQ: Seq = toSeq(0);

/** Наступний крок. Арифметика над Tick — тільки тут: `tick + 1` дало б звичайний number. */
export const nextTick = (t: Tick): Tick => brandAs((t + 1) >>> 0);

/** Чи seq `a` новіший за `b` з урахуванням переповнення u32. */
export const seqNewer = (a: Seq, b: Seq): boolean => a !== b && (a - b) >>> 0 < 0x80000000;

/** Молодші 16 біт seq: "мітка" кулі в знімку. */
export const seqTag = (s: Seq): number => s & 0xffff;
