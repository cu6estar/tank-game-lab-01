import type { EntityKind } from '../sim/entity.ts';
import type { PickupType } from '../sim/components.ts';

/**
 * Константи бінарного протоколу (див. docs/protocol-v1.md — це і є специфікація).
 * Один файл на клієнт і сервер: біти й коди в двох місцях не роз'їдуться.
 */

/** Перший байт кожного бінарного повідомлення. Змінюємо формат — піднімаємо. */
export const BINARY_VERSION = 1;

/** Другий байт: тип повідомлення. 0x0_ — клієнт→сервер, 0x8_ — сервер→клієнт. */
export const MSG = {
  INPUT: 0x01,
  PING: 0x02,
  SNAPSHOT: 0x81,
  PONG: 0x82,
} as const;
export type MsgType = (typeof MSG)[keyof typeof MSG];

/** Слот "не гравець" (вороги, нічиї кулі) у полях slot/owner. */
export const NO_SLOT = 255;

/** Скільки останніх вводів клієнт дублює в кожному пакеті (захист від втрати пакета). */
export const INPUT_REDUNDANCY = 3;
/** Жорстка межа для декодера: більше вводів у пакеті — це вже зловживання. */
export const MAX_INPUTS_PER_PACKET = 8;

/** Типи подій у знімку. */
export const EVENT = {
  FIRED: 1,
  HIT: 2,
  EXPLODED: 3,
  PICKUP: 4,
} as const;
export type EventType = (typeof EVENT)[keyof typeof EVENT];

/**
 * Види сутностей для подій (поле a у hit/exploded). `explosion` на дроті не
 * буває (вибухи клієнт створює сам), тому Partial: lookup дає `number | undefined`.
 */
export const KIND_CODE: Partial<Record<EntityKind, number>> = {
  ship: 1,
  bullet: 2,
  asteroid: 3,
  pickup: 4,
};

/** Квантування (мас­штаби). Змінити — означає змінити формат: піднімайте BINARY_VERSION. */
export const QUANT = {
  /** кут: Int16, ±π ↔ ±32767; крок ≈ 9.6e-5 рад (0.0055°) */
  ANGLE: 32767 / Math.PI,
  /** швидкість: Int16 у 1/8 px/с (±4095 px/с, крок 0.125) */
  VELOCITY: 8,
  /** перезарядка: Uint8 у кроках 5 мс (до 1.275 с) */
  COOLDOWN: 200,
  /** час дії ефекту: Uint8 у кроках 0.1 с (до 25.5 с) */
  EFFECT: 10,
} as const;

/** Порядок типів pickup-ів у протоколі (індекс = код). */
export const PICKUP_TYPES: readonly PickupType[] = [
  'shield',
  'rapidFire',
  'homingShots',
];

export const MAX_SCORE = 0xffff;

/** Максимум HP для підпису health-бару (знімок передає лише поточне hp). */
export const MAX_HP = { player: 100, enemy: 60 } as const;
