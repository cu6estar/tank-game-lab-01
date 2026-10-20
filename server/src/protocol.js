import { CodecError } from '@tank/shared/codec/errors.js';
import { validateInputs } from '@tank/shared/codec/input-validation.js';

/**
 * Протокол чату/кімнат, версія 2 (v1 + кодек, слоти, насіння матчу, input/ping).
 * Гру передають бінарні кадри (docs/protocol-v1.md) або JSON-еквіваленти нижче. Повідомлення — JSON-об'єкти з полем `type`.
 *
 * Клієнт → сервер:
 *   { type: 'join',  v: 2, room: '<id>', name: '<1–16 символів>', codec?: 'binary'|'json' }
 *   { type: 'input', inputs: [{ seq, throttle, turn, turretTurn, fire }] }   (лише кодек json)
 *   { type: 'ping',  t }
 *   { type: 'chat',  text: '<1–200 символів>' }
 *   { type: 'leave' }
 *
 * Сервер → клієнт:
 *   { type: 'welcome', v: 2, you: { id, name }, room: { id, name }, match: { seed, tickRate, codec } }
 *   { type: 'roster',  players: [{ id, name, slot }] }               при вході/виході
 *   { type: 'chat',    from: { id, name }, text, t }
 *   { type: 'error',   code, message }                               перед закриттям сокета
 *
 * Серверу не можна вірити, що клієнт — наш: validate() перевіряє КОЖНЕ
 * повідомлення, і будь-яке порушення закінчується закриттям сокета з кодом.
 */
export const PROTOCOL_VERSION = 2;

export const NAME_MAX = 16;
export const CHAT_MAX = 200;
export const ROOM_ID_MAX = 64;

/** Коди закриття. 4000–4999 — діапазон, зарезервований RFC 6455 для застосунків. */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // сервер зупиняється
  UNSUPPORTED_DATA: 1003, // бінарний кадр там, де чекаємо текст
  TOO_BIG: 1009, // це код, який сама ws шле при перевищенні maxPayload
  JOIN_TIMEOUT: 4000, // за 5 с не прийшов join
  BAD_MESSAGE: 4001, // не JSON / не об'єкт / неправильна форма
  UNKNOWN_TYPE: 4002,
  JOIN_REJECTED: 4003, // кімнати немає, заповнена, дубль join
  RATE_LIMIT: 4004,
  SLOW_CLIENT: 4005,
  BAD_VERSION: 4006,
});

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Рядок у межах довжини без керівних символів (щоб ім'я не ламало лог і UI). */
function cleanString(value, { min, max }) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < min || trimmed.length > max) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

const bad = (code, reason) => ({ ok: false, code, reason });

/**
 * Розбирає й перевіряє вхідний кадр.
 * @param {string} raw текст кадру
 * @returns {{ok:true, message:object} | {ok:false, code:number, reason:string}}
 */
export function parseMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return bad(CLOSE.BAD_MESSAGE, 'не JSON');
  }
  return validate(data);
}

export function validate(data) {
  if (!isPlainObject(data) || typeof data.type !== 'string') {
    return bad(CLOSE.BAD_MESSAGE, "очікується об'єкт з полем type");
  }

  switch (data.type) {
    case 'join': {
      if (data.v !== PROTOCOL_VERSION) {
        return bad(
          CLOSE.BAD_VERSION,
          `непідтримувана версія протоколу: ${data.v}`,
        );
      }
      const room = cleanString(data.room, { min: 1, max: ROOM_ID_MAX });
      const name = cleanString(data.name, { min: 1, max: NAME_MAX });
      if (!room) return bad(CLOSE.BAD_MESSAGE, 'join.room: рядок 1–64 символи');
      if (!name)
        return bad(
          CLOSE.BAD_MESSAGE,
          `join.name: рядок 1–${NAME_MAX} символів`,
        );
      const codec = data.codec ?? 'json';
      if (codec !== 'json' && codec !== 'binary')
        return bad(CLOSE.BAD_MESSAGE, 'join.codec: "json" або "binary"');
      return {
        ok: true,
        message: { type: 'join', v: PROTOCOL_VERSION, room, name, codec },
      };
    }

    case 'chat': {
      const text = cleanString(data.text, { min: 1, max: CHAT_MAX });
      if (!text)
        return bad(
          CLOSE.BAD_MESSAGE,
          `chat.text: рядок 1–${CHAT_MAX} символів`,
        );
      return { ok: true, message: { type: 'chat', text } };
    }

    case 'leave':
      return { ok: true, message: { type: 'leave' } };

    case 'input':
      try {
        return {
          ok: true,
          message: { type: 'input', inputs: validateInputs(data.inputs) },
        };
      } catch (error) {
        if (error instanceof CodecError)
          return bad(CLOSE.BAD_MESSAGE, error.message);
        throw error;
      }

    case 'ping':
      if (!Number.isFinite(data.t)) return bad(CLOSE.BAD_MESSAGE, 'ping.t');
      return { ok: true, message: { type: 'ping', t: data.t } };

    default:
      // Не повторюємо data.type у відповіді як є: це недовірений рядок
      return bad(CLOSE.UNKNOWN_TYPE, 'невідомий тип повідомлення');
  }
}

/** Серверні повідомлення збираємо в одному місці, щоб форма не роз'їжджалась. */
export const server = {
  welcome: (you, room, match = null) => ({
    type: 'welcome',
    v: PROTOCOL_VERSION,
    you,
    room,
    match,
  }),
  roster: (players) => ({ type: 'roster', players }),
  chat: (from, text, t = Date.now()) => ({ type: 'chat', from, text, t }),
  error: (code, message) => ({ type: 'error', code, message }),
};
