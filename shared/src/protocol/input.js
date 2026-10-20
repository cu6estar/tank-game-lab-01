/**
 * Ввід гравця за один крок: НЕ координати, а наміри. Усі осі — ціле −1/0/1.
 *   { seq, throttle, turn, turretTurn, fire }
 * seq зростає на 1 з кожним кроком клієнта; сервер підтверджує його у знімку (ack).
 */
export const IDLE_INPUT = Object.freeze({
  throttle: 0,
  turn: 0,
  turretTurn: 0,
  fire: false,
});

/** Чи seq `a` новіший за `b` з урахуванням переповнення u32. */
export const seqNewer = (a, b) => a !== b && (a - b) >>> 0 < 0x80000000;
