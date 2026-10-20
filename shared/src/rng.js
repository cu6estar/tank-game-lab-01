/**
 * mulberry32 — крихітний PRNG із 32-бітним станом. Той самий seed дає ту саму
 * послідовність у Chrome, Node і будь-якому іншому рушії: лише цілочисельні
 * операції (Math.imul, зсуви), жодної залежності від платформи.
 *
 * Math.random() у симуляції ЗАБОРОНЕНО: його не можна засіяти, тож клієнт і
 * сервер розійшлись би вже на першому випадковому числі.
 *
 * @param {number} seed будь-яке ціле (беремо молодші 32 біти)
 * @returns {() => number} генератор чисел у [0, 1)
 */
export function createRng(seed) {
  let state = seed >>> 0;

  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
