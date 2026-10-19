/**
 * Що робити з повідомленням для клієнта, у якого вже накопичилась черга
 * неперевіреної відправки (socket.bufferedAmount, байти).
 *
 *   'send'  — слати як зазвичай;
 *   'drop'  — некритичне (чат, у лабі 5 — зайві знімки стану) пропустити:
 *             свіжішого вже не доженемо, а черга лише росла б;
 *   'kill'  — клієнта не наздогнати навіть критичним: закрити сокет.
 *
 * Окремою чистою функцією, щоб політику можна було перевірити без мережі.
 */
export function slowClientAction({ buffered, critical, slowBytes, killBytes }) {
  if (buffered > killBytes) return 'kill';
  if (buffered > slowBytes && !critical) return 'drop';
  return 'send';
}
