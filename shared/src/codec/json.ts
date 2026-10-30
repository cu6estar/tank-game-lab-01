import { toTick } from '../brand.ts';
import type { Codec, Pong, Snapshot, WireData } from '../protocol/types.ts';
import { CodecError } from './errors.ts';
import { validateInputs } from './input-validation.ts';

/**
 * JSON-кодек: той самий зміст, що й бінарний, але текстом. Лишається за прапорцем
 * (`?codec=json`) — із ним зручно порівнювати розмір і CPU, а також дивитись
 * трафік у DevTools. Це ДІАГНОСТИЧНИЙ шлях: повну перевірку вмісту робить
 * бінарний декодер; тут лише каркас.
 */
function parseObject(data: WireData, expectedType: string): Record<string, unknown> {
  if (typeof data !== 'string') throw new CodecError('JSON-кодек очікує текст');
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new CodecError('не JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodecError('очікувався обʼєкт');
  }
  const record = parsed as Record<string, unknown>;
  if (record['type'] !== expectedType) {
    throw new CodecError(`очікувався тип "${expectedType}"`);
  }
  return record;
}

export const jsonCodec = {
  name: 'json',
  binary: false,

  encodeSnapshot: (snapshot) => JSON.stringify({ type: 'snapshot', ...snapshot }),

  decodeSnapshot(data): Snapshot {
    const parsed = parseObject(data, 'snapshot');
    for (const key of ['players', 'ships', 'bullets', 'asteroids', 'pickups', 'events'] as const) {
      if (!Array.isArray(parsed[key])) throw new CodecError(`snapshot.${key}: очікується масив`);
    }
    const tick = parsed['tick'];
    if (typeof tick !== 'number' || !Number.isInteger(tick)) throw new CodecError('snapshot.tick');
    const rest = { ...parsed };
    delete rest['type']; // службове поле кодека, у Snapshot його немає
    // as: діагностичний шлях довіряє власному encodeSnapshot; каркас перевірено вище
    return { ...(rest as unknown as Snapshot), tick: toTick(tick) };
  },

  encodeInputs: (inputs) => JSON.stringify({ type: 'input', inputs }),
  decodeInputs: (data) => validateInputs(parseObject(data, 'input')['inputs']),

  encodePing: (clientMs) => JSON.stringify({ type: 'ping', t: clientMs }),
  decodePing(data): number {
    const t = parseObject(data, 'ping')['t'];
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new CodecError('ping.t');
    return t;
  },

  encodePong: (echo, tick) => JSON.stringify({ type: 'pong', t: echo, tick }),
  decodePong(data): Pong {
    const record = parseObject(data, 'pong');
    const echo = record['t'];
    const tick = record['tick'];
    if (typeof echo !== 'number' || typeof tick !== 'number') throw new CodecError('pong');
    return { echo, tick };
  },
} satisfies Codec;
