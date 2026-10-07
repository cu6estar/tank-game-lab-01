import { fetchJson } from './assets/loader.js';

export const ROOMS_URL = '/api/rooms';

const DEFAULT_NAME = 'Pilot';
const MAX_NAME_LENGTH = 16;

/** Відповідь сервера має неправильну форму (валідний JSON, але не список кімнат). */
export class LobbyDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LobbyDataError';
  }
}

export function normalizeName(raw) {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || DEFAULT_NAME;
}

/**
 * Перевіряє відповідь /api/rooms. Дані з мережі — недовірені: некоректні
 * записи відкидаються, а якщо список не масив — це помилка, а не "порожнє лобі".
 */
export function parseRooms(data) {
  if (!Array.isArray(data)) {
    throw new LobbyDataError('Очікувався масив кімнат');
  }

  const rooms = [];
  for (const raw of data) {
    const valid =
      raw &&
      typeof raw.id === 'string' &&
      typeof raw.name === 'string' &&
      Number.isFinite(raw.players) &&
      Number.isFinite(raw.maxPlayers);
    if (!valid) continue;

    rooms.push({
      id: raw.id,
      name: raw.name,
      players: raw.players,
      maxPlayers: raw.maxPlayers,
      arena: raw.arena && typeof raw.arena === 'object' ? raw.arena : {},
    });
  }

  if (data.length > 0 && rooms.length === 0) {
    throw new LobbyDataError('Жоден запис кімнати не пройшов перевірку');
  }
  return rooms;
}

/**
 * Лобі: дані та мережа, без жодного DOM (його малює lobby-ui.js).
 *
 * Події:
 *   'loading'       почався запит
 *   'roomsChanged'  detail = масив кімнат (після успішного refresh)
 *   'error'         detail = Error (мережа, таймаут, 404/500, битий JSON…)
 *   'joined'        detail = { room, name, arena } — пора стартувати гру
 *
 * Правила запитів:
 *   — кожен має AbortSignal.timeout (усередині fetchChecked);
 *   — новий refresh() спершу скасовує попередній, що ще в польоті;
 *   — stop() (гравець пішов з лобі) скасовує запит і зупиняє таймер.
 */
export class Lobby extends EventTarget {
  #controller = null; // AbortController запиту, що зараз у польоті
  #timer = 0;
  #running = false;
  #fetch;
  #url;
  #intervalMs;
  #timeoutMs;

  rooms = [];
  playerName = '';

  constructor({
    url = ROOMS_URL,
    intervalMs = 4000,
    timeoutMs = 3000,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  } = {}) {
    super();
    this.#url = url;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  get running() {
    return this.#running;
  }

  /** Чи є запит у польоті (для тестів і індикатора в UI). */
  get pending() {
    return this.#controller !== null;
  }

  /** Лобі показано: одразу оновити список і далі оновлювати по інтервалу. */
  start() {
    if (this.#running) return;
    this.#running = true;

    this.refresh();
    // Стрілка зберігає `this` (Lobby); голий this.refresh у setInterval був би
    // викликаний з this = undefined — той самий баг, що й з ship.fire.
    this.#timer = setInterval(() => this.refresh(), this.#intervalMs);
  }

  /** Гравець покинув лобі: зупинити таймер і скасувати запит у польоті. */
  stop() {
    this.#running = false;
    clearInterval(this.#timer);
    this.#timer = 0;

    this.#controller?.abort();
    this.#controller = null;
  }

  async refresh() {
    // Старий запит більше не потрібен: його відповідь могла б прийти ПІСЛЯ
    // нової і затерти свіжіші дані.
    this.#controller?.abort();

    const controller = new AbortController();
    this.#controller = controller;
    this.dispatchEvent(new CustomEvent('loading'));

    try {
      const data = await fetchJson(this.#url, {
        signal: controller.signal,
        timeoutMs: this.#timeoutMs,
        fetch: this.#fetch,
      });
      const rooms = parseRooms(data);

      if (controller.signal.aborted) return;
      this.rooms = rooms;
      this.dispatchEvent(new CustomEvent('roomsChanged', { detail: rooms }));
    } catch (error) {
      // abort — наша власна дія (новий refresh або вихід із лобі), не збій
      if (controller.signal.aborted) return;
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  /** Вступити в кімнату: зупиняє лобі й повідомляє, з яким конфігом арени грати. */
  join(roomId) {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new Error(`Кімнату "${roomId}" не знайдено`);
    if (room.players >= room.maxPlayers) {
      throw new Error(`Кімната "${room.name}" заповнена`);
    }

    const name = normalizeName(this.playerName);
    this.stop();

    const detail = { room, name, arena: room.arena };
    this.dispatchEvent(new CustomEvent('joined', { detail }));
    return detail;
  }
}
