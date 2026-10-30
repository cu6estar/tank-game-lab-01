import type { EntityId, Seq, Tick } from '../brand.ts';

/**
 * Типи "дроту": форма знімка й вводу, незалежна від кодека (JSON чи бінарний
 * пишуть ОДНЕ Й ТЕ САМЕ). Branded-типи (`EntityId`, `Tick`, `Seq`) не дають
 * переплутати id сутності, номер кроку й номер вводу — для JS це все number,
 * для tsc — різні типи.
 */

/** Вісь керування: лише −1, 0 або 1 (це гарантують схема й декодер). */
export type Axis = -1 | 0 | 1;

/** Ввід гравця за один крок: наміри, не координати. */
export interface ClientInput {
  readonly seq: Seq;
  readonly throttle: Axis;
  readonly turn: Axis;
  readonly turretTurn: Axis;
  readonly fire: boolean;
}

export interface SnapshotPlayer {
  readonly slot: number;
  /** ack: останній ВИКОНАНИЙ seq цього гравця. */
  readonly ack: Seq;
  readonly score: number;
}

export interface SnapshotShip {
  readonly id: EntityId;
  readonly slot: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
  readonly turret: number;
  readonly hp: number;
  readonly cooldown: number;
  readonly shield: number;
  readonly rapid: number;
  readonly homing: number;
}

export interface SnapshotBullet {
  readonly id: EntityId;
  readonly owner: number;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly homing: boolean;
  /** Молодші 16 біт seq, що вистрілив: клієнт впізнає свою передбачену кулю. */
  readonly tag: number;
}

export interface SnapshotAsteroid {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly radius: number;
  readonly homing: boolean;
  readonly seed: number;
}

export interface SnapshotPickup {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  /** Індекс у PICKUP_TYPES. */
  readonly type: number;
}

/** Подія кроку (постріл, влучання, вибух, підбір) — для звуку й ефектів клієнта. */
export interface SnapshotEvent {
  readonly type: number;
  readonly a: number;
  readonly b: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Повний стан на один крок. Лише те, що потрібно клієнту: id для прив'язки,
 * координати для малювання та інтерполяції, свій корабель — для передбачення.
 */
export interface Snapshot {
  readonly tick: Tick;
  readonly players: readonly SnapshotPlayer[];
  readonly ships: readonly SnapshotShip[];
  readonly bullets: readonly SnapshotBullet[];
  readonly asteroids: readonly SnapshotAsteroid[];
  readonly pickups: readonly SnapshotPickup[];
  readonly events: readonly SnapshotEvent[];
}

export interface Pong {
  readonly echo: number;
  readonly tick: number;
}

/** Імена кодеків. Нове ім'я тут одразу вимагає запису в CODECS (інакше tsc). */
export type CodecName = 'binary' | 'json';

/** Що віддає encode і що приймає transport: текст (JSON) або байти (бінарний). */
export type EncodedFrame = string | Uint8Array;
/** Що приймає decode з мережі: текст або будь-який бінарний буфер. */
export type WireData = string | ArrayBuffer | ArrayBufferView;

/**
 * Кодек: обидва (JSON і бінарний) кодують однакові типи. Інтерфейс однаковий,
 * тож `getCodec(name)` повертає взаємозамінний об'єкт. decode приймає `unknown`
 * з мережі у вигляді `WireData` і сам перевіряє вміст (кидає CodecError).
 */
export interface Codec {
  readonly name: CodecName;
  readonly binary: boolean;
  encodeSnapshot(snapshot: Snapshot): EncodedFrame;
  decodeSnapshot(data: WireData): Snapshot;
  encodeInputs(inputs: readonly ClientInput[]): EncodedFrame;
  decodeInputs(data: WireData): ClientInput[];
  encodePing(clientMs: number): EncodedFrame;
  decodePing(data: WireData): number;
  encodePong(echo: number, tick: number): EncodedFrame;
  decodePong(data: WireData): Pong;
}
