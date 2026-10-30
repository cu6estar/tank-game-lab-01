import { z } from 'zod';
import { CodecError } from '@tank/shared/codec/errors.ts';
import { validateInputs } from '@tank/shared/codec/input-validation.ts';
import type { ClientInput, CodecName } from '@tank/shared/protocol/types.ts';

/**
 * Протокол чату/кімнат, версія 2 (v1 + кодек, слоти, насіння матчу, input/ping).
 * Гру передають бінарні кадри (docs/protocol-v1.md) або JSON-еквіваленти.
 *
 * Клієнт → сервер:
 *   { type: 'join',  v: 2, room, name, codec?: 'binary'|'json' }
 *   { type: 'input', inputs: [{ seq, throttle, turn, turretTurn, fire }] }
 *   { type: 'ping',  t }
 *   { type: 'chat',  text }
 *   { type: 'leave' }
 *
 * Сервер → клієнт: welcome / roster / chat / error.
 *
 * Серверу не можна вірити, що клієнт — наш. У лабі 4 це була ручна перевірка;
 * тепер форму описують СХЕМИ Zod, а тип повідомлення ВИВОДИТЬСЯ зі схеми
 * (`z.infer`). Схеми перевіряють дані в рантаймі (типи стираються при збірці),
 * і будь-яке порушення закінчується закриттям сокета з кодом.
 */
export const PROTOCOL_VERSION = 2;

export const NAME_MAX = 16;
export const CHAT_MAX = 200;
export const ROOM_ID_MAX = 64;

/** Коди закриття. 4000–4999 — діапазон, зарезервований RFC 6455 для застосунків. */
export const CLOSE = {
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
} as const;
export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Рядок у межах довжини без керівних символів (щоб ім'я не ламало лог і UI). */
const cleanString = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .refine((s) => s.length >= min && s.length <= max && !CONTROL_CHARS.test(s), {
      message: `рядок ${min}–${max} символів без керівних символів`,
    });

const JoinSchema = z.object({
  type: z.literal('join'),
  v: z.literal(PROTOCOL_VERSION),
  room: cleanString(1, ROOM_ID_MAX),
  name: cleanString(1, NAME_MAX),
  codec: z.enum(['json', 'binary']).default('json'),
});

const ChatSchema = z.object({ type: z.literal('chat'), text: cleanString(1, CHAT_MAX) });
const LeaveSchema = z.object({ type: z.literal('leave') });
// inputs перевіряє validateInputs (спільний код кодека): він і брендує seq
const InputSchema = z.object({ type: z.literal('input'), inputs: z.array(z.unknown()).min(1) });
const PingSchema = z.object({ type: z.literal('ping'), t: z.number().finite() });

const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinSchema,
  ChatSchema,
  LeaveSchema,
  InputSchema,
  PingSchema,
]);

/** Повідомлення після перевірки. Тип виведено зі схем (`input.inputs` — вже ClientInput[]). */
export type ClientMessage =
  | { type: 'join'; v: typeof PROTOCOL_VERSION; room: string; name: string; codec: CodecName }
  | { type: 'chat'; text: string }
  | { type: 'leave' }
  | { type: 'input'; inputs: ClientInput[] }
  | { type: 'ping'; t: number };

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: CloseCode; reason: string };

const bad = (code: CloseCode, reason: string): ParseResult => ({ ok: false, code, reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Перевіряє вже розібране значення (unknown — межа процесу). Нічого не кидає.
 * Вибір коду закриття повторює лабу 4: невідомий РЯДКОВИЙ type → UNKNOWN_TYPE,
 * погана версія join → BAD_VERSION, решта (зокрема не-об'єкт) → BAD_MESSAGE.
 */
export function parseClientMessage(raw: unknown): ParseResult {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') {
    return bad(CLOSE.BAD_MESSAGE, "очікується об'єкт з полем type");
  }

  const result = ClientMessageSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues;
    if (issues.some((i) => i.code === 'invalid_union_discriminator')) {
      return bad(CLOSE.UNKNOWN_TYPE, 'невідомий тип повідомлення');
    }
    if (issues.some((i) => i.path[0] === 'v')) {
      return bad(CLOSE.BAD_VERSION, 'непідтримувана версія протоколу');
    }
    return bad(CLOSE.BAD_MESSAGE, issues[0]?.message ?? 'неправильна форма');
  }

  const data = result.data;
  if (data.type === 'input') {
    try {
      return { ok: true, message: { type: 'input', inputs: validateInputs(data.inputs) } };
    } catch (error: unknown) {
      if (error instanceof CodecError) return bad(CLOSE.BAD_MESSAGE, error.message);
      throw error;
    }
  }
  return { ok: true, message: data };
}

/** Текстовий кадр: розібрати JSON (битий JSON — не виняток, а BAD_MESSAGE) і перевірити. */
export function parseMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return bad(CLOSE.BAD_MESSAGE, 'не JSON');
  }
  return parseClientMessage(data);
}

// ----------------------------------------------------- серверні повідомлення

export interface PlayerRef {
  readonly id: string;
  readonly name: string;
}
export interface RoomRef {
  readonly id: string;
  readonly name: string;
}
export interface MatchInfo {
  readonly seed: number;
  readonly tickRate: number;
  readonly codec: CodecName;
}
export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly slot: number;
}

/** Серверні повідомлення збираємо в одному місці, щоб форма не роз'їжджалась. */
export const server = {
  welcome: (you: PlayerRef, room: RoomRef, match: MatchInfo | null = null) => ({
    type: 'welcome' as const,
    v: PROTOCOL_VERSION,
    you,
    room,
    match,
  }),
  roster: (players: readonly RosterEntry[]) => ({ type: 'roster' as const, players }),
  chat: (from: PlayerRef, text: string, t: number = Date.now()) => ({
    type: 'chat' as const,
    from,
    text,
    t,
  }),
  error: (code: number, message: string) => ({ type: 'error' as const, code, message }),
};
