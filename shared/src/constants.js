/** Константи, спільні для клієнта й сервера. Змінюєш тут — міняється скрізь. */

/** Кроків симуляції на секунду. Сервер крокує з цією частотою; клієнт — теж. */
export const TICK_RATE = 30;
/** Фіксований dt кроку, секунд. Усюди ОДНЕ й те саме число. */
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** Розмір арени в "логічних" пікселях. Клієнт масштабує її під вікно. */
export const ARENA_WIDTH = 1280;
export const ARENA_HEIGHT = 720;

export const MAX_PLAYERS = 8;
