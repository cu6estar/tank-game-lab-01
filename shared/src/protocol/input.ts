import type { Axis } from './types.ts';

/**
 * Ввід гравця за один крок: НЕ координати, а наміри. Усі осі — ціле −1/0/1.
 *   { seq, throttle, turn, turretTurn, fire }
 * seq зростає на 1 з кожним кроком клієнта; сервер підтверджує його у знімку (ack).
 */

/** Намір "нічого не робити" (ще без seq — його додає клієнт на кроці). */
export const IDLE_INPUT: {
  readonly throttle: Axis;
  readonly turn: Axis;
  readonly turretTurn: Axis;
  readonly fire: boolean;
} = Object.freeze({
  throttle: 0,
  turn: 0,
  turretTurn: 0,
  fire: false,
});

// seqNewer живе в brand.ts (типізований для Seq); тут лише реекспорт для
// сумісності зі старими імпортами `@tank/shared/protocol/input.ts`.
export { seqNewer } from '../brand.ts';
