import { toSeq } from '../brand.ts';
import { MAX_INPUTS_PER_PACKET } from '../protocol/constants.ts';
import type { Axis, ClientInput } from '../protocol/types.ts';
import { CodecError } from './errors.ts';

const isAxis = (v: unknown): v is Axis => v === -1 || v === 0 || v === 1;

const isU32 = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/**
 * Перевірка вводу з мережі (однакова для JSON і бінарного кодека): оси — цілі
 * −1/0/1, fire — булеве, seq — u32. Клієнту не вірити: NaN, 5 чи рядок
 * не "виправляємо", а відхиляємо. Приймає `unknown` — це межа процесу.
 */
export function validateInputs(list: unknown): ClientInput[] {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_INPUTS_PER_PACKET) {
    throw new CodecError(`inputs: очікується 1–${MAX_INPUTS_PER_PACKET} елементів`);
  }

  return list.map((raw: unknown): ClientInput => {
    if (typeof raw !== 'object' || raw === null) {
      throw new CodecError('input: неправильна форма');
    }
    // звужуємо до словника, щоб читати поля; значення лишаються unknown
    const r = raw as Record<string, unknown>;
    if (
      !isU32(r['seq']) ||
      !isAxis(r['throttle']) ||
      !isAxis(r['turn']) ||
      !isAxis(r['turretTurn']) ||
      typeof r['fire'] !== 'boolean'
    ) {
      throw new CodecError('input: неправильна форма');
    }

    return {
      seq: toSeq(r['seq']),
      throttle: r['throttle'],
      turn: r['turn'],
      turretTurn: r['turretTurn'],
      fire: r['fire'],
    };
  });
}
