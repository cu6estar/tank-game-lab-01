import { CodecError } from './errors.js';
import { validateInputs } from './input-validation.js';

/**
 * JSON-кодек: той самий зміст, що й бінарний, але текстом. Лишається за прапорцем
 * (`?codec=json`) — із ним зручно порівнювати розмір і CPU, а також дивитись
 * трафік у DevTools.
 */
function parse(text, expectedType) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CodecError('не JSON');
  }
  if (!data || typeof data !== 'object' || data.type !== expectedType) {
    throw new CodecError(`очікувався тип "${expectedType}"`);
  }
  return data;
}

export const jsonCodec = {
  name: 'json',
  binary: false,

  encodeSnapshot: (snapshot) =>
    JSON.stringify({ type: 'snapshot', ...snapshot }),

  decodeSnapshot(text) {
    const { ...snapshot } = parse(text, 'snapshot');
    delete snapshot.type;
    for (const key of [
      'players',
      'ships',
      'bullets',
      'asteroids',
      'pickups',
      'events',
    ]) {
      if (!Array.isArray(snapshot[key]))
        throw new CodecError(`snapshot.${key}: очікується масив`);
    }
    if (!Number.isInteger(snapshot.tick)) throw new CodecError('snapshot.tick');
    return snapshot;
  },

  encodeInputs: (inputs) => JSON.stringify({ type: 'input', inputs }),
  decodeInputs: (text) => validateInputs(parse(text, 'input').inputs),

  encodePing: (clientMs) => JSON.stringify({ type: 'ping', t: clientMs }),
  decodePing(text) {
    const { t } = parse(text, 'ping');
    if (!Number.isFinite(t)) throw new CodecError('ping.t');
    return t;
  },

  encodePong: (echo, tick) => JSON.stringify({ type: 'pong', t: echo, tick }),
  decodePong(text) {
    const { t, tick } = parse(text, 'pong');
    return { echo: t, tick };
  },
};
