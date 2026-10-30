import type { Codec, CodecName } from '../protocol/types.ts';
import { binaryCodec } from './binary.ts';
import { CodecError } from './errors.ts';
import { jsonCodec } from './json.ts';

export { binaryCodec, jsonCodec, CodecError };
export { peekType } from './binary.ts';
export type { Codec, CodecName } from '../protocol/types.ts';

export const CODECS: Readonly<Record<CodecName, Codec>> = Object.freeze({
  binary: binaryCodec,
  json: jsonCodec,
});

/** Перевіряє, що рядок — відоме ім'я кодека (дані з мережі: codec у join). */
export function isCodecName(name: unknown): name is CodecName {
  return name === 'binary' || name === 'json';
}

/** Кодек за іменем; невідоме ім'я — помилка, а не мовчазне "json". */
export function getCodec(name: CodecName): Codec {
  return CODECS[name];
}
