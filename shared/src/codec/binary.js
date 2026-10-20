import { wrapAngle } from '../sim/vector.js';
import {
  BINARY_VERSION,
  MAX_INPUTS_PER_PACKET,
  MAX_SCORE,
  MSG,
  QUANT,
} from '../protocol/constants.js';
import { CodecError } from './errors.js';
import { validateInputs } from './input-validation.js';

/**
 * Бінарний кодек на DataView. Специфікація — docs/protocol-v1.md.
 *
 * Правила формату:
 *   — ПОРЯДОК БАЙТІВ little-endian, явно в кожному виклику (set…/get…(offset, true)).
 *     Без прапорця DataView читає big-endian, а Float32Array/Uint16Array — у порядку
 *     процесора: для мережі ні те, ні те не годиться (див. exp:bytes);
 *   — перший байт — версія формату, другий — тип повідомлення;
 *   — кут — Int16, швидкості — Int16, таймери — Uint8: квантування замість Float32/64;
 *   — довжина повідомлення перевіряється до читання (ніяких виходів за межі буфера).
 */

// Розміри записів, байт
const HEADER = 2; // version + type
const PLAYER = 7; // slot u8, ack u32, score u16
const SHIP = 24;
const BULLET = 18;
const ASTEROID = 16;
const PICKUP = 11;
const EVENT = 11; // type u8, a u8, b u8, x f32, y f32
const INPUT = 8; // seq u32, 3×i8, flags u8

const clampInt = (value, min, max) =>
  Math.max(min, Math.min(max, Math.round(value)));

const encodeAngle = (angle) =>
  clampInt(wrapAngle(angle) * QUANT.ANGLE, -32767, 32767);
const decodeAngle = (q) => q / QUANT.ANGLE;
const encodeVel = (v) => clampInt(v * QUANT.VELOCITY, -32768, 32767);
const decodeVel = (q) => q / QUANT.VELOCITY;
const encodeTimer = (seconds, scale) => clampInt(seconds * scale, 0, 255);

/** Нормалізує вхід (ArrayBuffer | Uint8Array | Buffer) до DataView. */
function viewOf(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data))
    return new DataView(data.buffer, data.byteOffset, data.byteLength);
  throw new CodecError('очікувався бінарний кадр');
}

function expectHeader(view, type) {
  if (view.byteLength < HEADER)
    throw new CodecError('кадр коротший за заголовок');
  const version = view.getUint8(0);
  if (version !== BINARY_VERSION)
    throw new CodecError(`непідтримувана версія формату: ${version}`);
  if (view.getUint8(1) !== type)
    throw new CodecError(`очікувався тип 0x${type.toString(16)}`);
}

function need(view, offset, bytes, what) {
  if (offset + bytes > view.byteLength)
    throw new CodecError(`кадр обірвано (${what})`);
}

/** Тип бінарного повідомлення (для диспетчеризації), або -1, якщо кадр порожній. */
export function peekType(data) {
  const view = viewOf(data);
  return view.byteLength >= HEADER ? view.getUint8(1) : -1;
}

export const binaryCodec = {
  name: 'binary',
  binary: true,

  // ------------------------------------------------------------- знімок
  encodeSnapshot(s) {
    const size =
      HEADER +
      4 + // tick
      1 +
      s.players.length * PLAYER +
      2 +
      s.ships.length * SHIP +
      2 +
      s.bullets.length * BULLET +
      2 +
      s.asteroids.length * ASTEROID +
      2 +
      s.pickups.length * PICKUP +
      1 +
      s.events.length * EVENT;

    const buffer = new ArrayBuffer(size);
    const v = new DataView(buffer);
    let o = 0;

    v.setUint8(o++, BINARY_VERSION);
    v.setUint8(o++, MSG.SNAPSHOT);
    v.setUint32(o, s.tick >>> 0, true);
    o += 4;

    v.setUint8(o++, s.players.length);
    for (const p of s.players) {
      v.setUint8(o++, p.slot);
      v.setUint32(o, p.ack >>> 0, true);
      o += 4;
      v.setUint16(o, Math.min(MAX_SCORE, Math.max(0, p.score)), true);
      o += 2;
    }

    v.setUint16(o, s.ships.length, true);
    o += 2;
    for (const e of s.ships) {
      v.setUint16(o, e.id, true);
      o += 2;
      v.setUint8(o++, e.slot);
      v.setFloat32(o, e.x, true);
      o += 4;
      v.setFloat32(o, e.y, true);
      o += 4;
      v.setInt16(o, encodeVel(e.vx), true);
      o += 2;
      v.setInt16(o, encodeVel(e.vy), true);
      o += 2;
      v.setInt16(o, encodeAngle(e.angle), true);
      o += 2;
      v.setInt16(o, encodeAngle(e.turret), true);
      o += 2;
      v.setUint8(o++, clampInt(e.hp, 0, 255));
      v.setUint8(o++, encodeTimer(e.cooldown, QUANT.COOLDOWN));
      v.setUint8(o++, encodeTimer(e.shield, QUANT.EFFECT));
      v.setUint8(o++, encodeTimer(e.rapid, QUANT.EFFECT));
      v.setUint8(o++, encodeTimer(e.homing, QUANT.EFFECT));
    }

    v.setUint16(o, s.bullets.length, true);
    o += 2;
    for (const e of s.bullets) {
      v.setUint16(o, e.id, true);
      o += 2;
      v.setUint8(o++, e.owner);
      v.setFloat32(o, e.x, true);
      o += 4;
      v.setFloat32(o, e.y, true);
      o += 4;
      v.setInt16(o, encodeVel(e.vx), true);
      o += 2;
      v.setInt16(o, encodeVel(e.vy), true);
      o += 2;
      v.setUint8(o++, e.homing ? 1 : 0);
      v.setUint16(o, e.tag & 0xffff, true);
      o += 2;
    }

    v.setUint16(o, s.asteroids.length, true);
    o += 2;
    for (const e of s.asteroids) {
      v.setUint16(o, e.id, true);
      o += 2;
      v.setFloat32(o, e.x, true);
      o += 4;
      v.setFloat32(o, e.y, true);
      o += 4;
      v.setInt16(o, encodeAngle(e.angle), true);
      o += 2;
      v.setUint8(o++, clampInt(e.radius, 0, 255));
      v.setUint8(o++, e.homing ? 1 : 0);
      v.setUint16(o, e.seed & 0xffff, true);
      o += 2;
    }

    v.setUint16(o, s.pickups.length, true);
    o += 2;
    for (const e of s.pickups) {
      v.setUint16(o, e.id, true);
      o += 2;
      v.setFloat32(o, e.x, true);
      o += 4;
      v.setFloat32(o, e.y, true);
      o += 4;
      v.setUint8(o++, e.type);
    }

    v.setUint8(o++, s.events.length);
    for (const e of s.events) {
      v.setUint8(o++, e.type);
      v.setUint8(o++, e.a);
      v.setUint8(o++, e.b);
      v.setFloat32(o, e.x, true);
      o += 4;
      v.setFloat32(o, e.y, true);
      o += 4;
    }

    return new Uint8Array(buffer);
  },

  decodeSnapshot(data) {
    const v = viewOf(data);
    expectHeader(v, MSG.SNAPSHOT);
    let o = HEADER;

    need(v, o, 5, 'tick');
    const tick = v.getUint32(o, true);
    o += 4;

    const section = (countBytes, recordSize, what, read) => {
      need(v, o, countBytes, `${what}: лічильник`);
      const count = countBytes === 1 ? v.getUint8(o) : v.getUint16(o, true);
      o += countBytes;
      need(v, o, count * recordSize, what);
      const list = [];
      for (let i = 0; i < count; i++) {
        list.push(read());
        o += recordSize;
      }
      return list;
    };

    // під час read() змінна o вказує на початок запису; зсув робить section
    const players = section(1, PLAYER, 'players', () => ({
      slot: v.getUint8(o),
      ack: v.getUint32(o + 1, true),
      score: v.getUint16(o + 5, true),
    }));

    const ships = section(2, SHIP, 'ships', () => ({
      id: v.getUint16(o, true),
      slot: v.getUint8(o + 2),
      x: v.getFloat32(o + 3, true),
      y: v.getFloat32(o + 7, true),
      vx: decodeVel(v.getInt16(o + 11, true)),
      vy: decodeVel(v.getInt16(o + 13, true)),
      angle: decodeAngle(v.getInt16(o + 15, true)),
      turret: decodeAngle(v.getInt16(o + 17, true)),
      hp: v.getUint8(o + 19),
      cooldown: v.getUint8(o + 20) / QUANT.COOLDOWN,
      shield: v.getUint8(o + 21) / QUANT.EFFECT,
      rapid: v.getUint8(o + 22) / QUANT.EFFECT,
      homing: v.getUint8(o + 23) / QUANT.EFFECT,
    }));

    const bullets = section(2, BULLET, 'bullets', () => ({
      id: v.getUint16(o, true),
      owner: v.getUint8(o + 2),
      x: v.getFloat32(o + 3, true),
      y: v.getFloat32(o + 7, true),
      vx: decodeVel(v.getInt16(o + 11, true)),
      vy: decodeVel(v.getInt16(o + 13, true)),
      homing: v.getUint8(o + 15) === 1,
      tag: v.getUint16(o + 16, true),
    }));

    const asteroids = section(2, ASTEROID, 'asteroids', () => ({
      id: v.getUint16(o, true),
      x: v.getFloat32(o + 2, true),
      y: v.getFloat32(o + 6, true),
      angle: decodeAngle(v.getInt16(o + 10, true)),
      radius: v.getUint8(o + 12),
      homing: v.getUint8(o + 13) === 1,
      seed: v.getUint16(o + 14, true),
    }));

    const pickups = section(2, PICKUP, 'pickups', () => ({
      id: v.getUint16(o, true),
      x: v.getFloat32(o + 2, true),
      y: v.getFloat32(o + 6, true),
      type: v.getUint8(o + 10),
    }));

    const events = section(1, EVENT, 'events', () => ({
      type: v.getUint8(o),
      a: v.getUint8(o + 1),
      b: v.getUint8(o + 2),
      x: v.getFloat32(o + 3, true),
      y: v.getFloat32(o + 7, true),
    }));

    if (o !== v.byteLength)
      throw new CodecError(`зайві байти в кінці знімка: ${v.byteLength - o}`);
    return { tick, players, ships, bullets, asteroids, pickups, events };
  },

  // ------------------------------------------------------------- ввід
  encodeInputs(inputs) {
    const buffer = new ArrayBuffer(HEADER + 1 + inputs.length * INPUT);
    const v = new DataView(buffer);
    v.setUint8(0, BINARY_VERSION);
    v.setUint8(1, MSG.INPUT);
    v.setUint8(2, inputs.length);
    let o = 3;
    for (const input of inputs) {
      v.setUint32(o, input.seq >>> 0, true);
      o += 4;
      v.setInt8(o++, input.throttle);
      v.setInt8(o++, input.turn);
      v.setInt8(o++, input.turretTurn);
      v.setUint8(o++, input.fire ? 1 : 0);
    }
    return new Uint8Array(buffer);
  },

  decodeInputs(data) {
    const v = viewOf(data);
    expectHeader(v, MSG.INPUT);
    need(v, HEADER, 1, 'input: лічильник');
    const count = v.getUint8(2);
    if (count === 0 || count > MAX_INPUTS_PER_PACKET) {
      throw new CodecError(
        `input: ${count} вводів у пакеті (дозволено 1–${MAX_INPUTS_PER_PACKET})`,
      );
    }
    if (v.byteLength !== 3 + count * INPUT) {
      throw new CodecError(
        `input: довжина ${v.byteLength}, очікувалось ${3 + count * INPUT}`,
      );
    }

    const list = [];
    let o = 3;
    for (let i = 0; i < count; i++) {
      const flags = v.getUint8(o + 7);
      if (flags > 1) throw new CodecError('input: невідомі біти flags');
      list.push({
        seq: v.getUint32(o, true),
        throttle: v.getInt8(o + 4),
        turn: v.getInt8(o + 5),
        turretTurn: v.getInt8(o + 6),
        fire: flags === 1,
      });
      o += INPUT;
    }
    return validateInputs(list);
  },

  // ------------------------------------------------------- ping / pong
  encodePing(clientMs) {
    const v = new DataView(new ArrayBuffer(HEADER + 4));
    v.setUint8(0, BINARY_VERSION);
    v.setUint8(1, MSG.PING);
    v.setUint32(2, clientMs >>> 0, true);
    return new Uint8Array(v.buffer);
  },

  decodePing(data) {
    const v = viewOf(data);
    expectHeader(v, MSG.PING);
    if (v.byteLength !== HEADER + 4)
      throw new CodecError('ping: неправильна довжина');
    return v.getUint32(2, true);
  },

  encodePong(echo, tick) {
    const v = new DataView(new ArrayBuffer(HEADER + 8));
    v.setUint8(0, BINARY_VERSION);
    v.setUint8(1, MSG.PONG);
    v.setUint32(2, echo >>> 0, true);
    v.setUint32(6, tick >>> 0, true);
    return new Uint8Array(v.buffer);
  },

  decodePong(data) {
    const v = viewOf(data);
    expectHeader(v, MSG.PONG);
    if (v.byteLength !== HEADER + 8)
      throw new CodecError('pong: неправильна довжина');
    return { echo: v.getUint32(2, true), tick: v.getUint32(6, true) };
  },
};
