import { MAX_INPUTS_PER_PACKET } from '../protocol/constants.js';
import { CodecError } from './errors.js';

const isAxis = (v) => Number.isInteger(v) && v >= -1 && v <= 1;

/**
 * Перевірка вводу з мережі (однакова для JSON і бінарного кодека): оси — цілі
 * −1/0/1, fire — булеве, seq — u32. Клієнту не вірити: NaN, 5 чи рядок
 * не "виправляємо", а відхиляємо.
 */
export function validateInputs(list) {
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > MAX_INPUTS_PER_PACKET
  ) {
    throw new CodecError(
      `inputs: очікується 1–${MAX_INPUTS_PER_PACKET} елементів`,
    );
  }

  return list.map((raw) => {
    const ok =
      raw &&
      typeof raw === 'object' &&
      Number.isInteger(raw.seq) &&
      raw.seq >= 0 &&
      raw.seq <= 0xffffffff &&
      isAxis(raw.throttle) &&
      isAxis(raw.turn) &&
      isAxis(raw.turretTurn) &&
      typeof raw.fire === 'boolean';
    if (!ok) throw new CodecError('input: неправильна форма');

    return {
      seq: raw.seq,
      throttle: raw.throttle,
      turn: raw.turn,
      turretTurn: raw.turretTurn,
      fire: raw.fire,
    };
  });
}
