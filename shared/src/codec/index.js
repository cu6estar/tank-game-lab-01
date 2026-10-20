import { binaryCodec } from './binary.js';
import { CodecError } from './errors.js';
import { jsonCodec } from './json.js';

export { binaryCodec, jsonCodec, CodecError };
export { peekType } from './binary.js';

export const CODECS = Object.freeze({ binary: binaryCodec, json: jsonCodec });

/** Кодек за іменем; невідоме ім'я — помилка, а не мовчазне "json". */
export function getCodec(name) {
  const codec = CODECS[name];
  if (!codec) throw new CodecError(`невідомий кодек "${name}"`);
  return codec;
}
