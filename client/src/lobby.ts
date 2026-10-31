import { fetchJson } from './assets/loader.ts';

export const ROOMS_URL = '/api/rooms';

const DEFAULT_NAME = 'Pilot';
const MAX_NAME_LENGTH = 16;

export class LobbyDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LobbyDataError';
  }
}

export type LobbyArena = Record<string, number>;

export interface LobbyRoom {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  arena: LobbyArena;
}

export interface JoinedDetail {
  room: LobbyRoom;
  name: string;
  arena: LobbyArena;
}

export function normalizeName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return name || DEFAULT_NAME;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/**
 * Перевіряє відповідь /api/rooms. Дані з мережі недовірені: некоректні записи
 * відкидаються, а якщо список не масив — це помилка, а не "порожнє лобі".
 */
export function parseRooms(data: unknown): LobbyRoom[] {
  if (!Array.isArray(data)) throw new LobbyDataError('Очікувався масив кімнат');

  const rooms: LobbyRoom[] = [];
  for (const raw of data) {
    const rec = asRecord(raw);
    if (
      !rec ||
      typeof rec['id'] !== 'string' ||
      typeof rec['name'] !== 'string' ||
      typeof rec['players'] !== 'number' ||
      !Number.isFinite(rec['players']) ||
      typeof rec['maxPlayers'] !== 'number' ||
      !Number.isFinite(rec['maxPlayers'])
    ) {
      continue;
    }

    const arena: LobbyArena = {};
    const rawArena = asRecord(rec['arena']);
    if (rawArena) {
      for (const [key, value] of Object.entries(rawArena)) {
        if (typeof value === 'number') arena[key] = value;
      }
    }

    rooms.push({ id: rec['id'], name: rec['name'], players: rec['players'], maxPlayers: rec['maxPlayers'], arena });
  }

  if (data.length > 0 && rooms.length === 0) {
    throw new LobbyDataError('Жоден запис кімнати не пройшов перевірку');
  }
  return rooms;
}

export interface LobbyOptions {
  url?: string;
  intervalMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface LobbyEventMap {
  loading: CustomEvent<undefined>;
  roomsChanged: CustomEvent<LobbyRoom[]>;
  error: CustomEvent<unknown>;
  joined: CustomEvent<JoinedDetail>;
}

export interface Lobby {
  addEventListener<K extends keyof LobbyEventMap>(type: K, listener: (event: LobbyEventMap[K]) => void, options?: AddEventListenerOptions | boolean): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void;
}

/** Лобі: дані та мережа, без жодного DOM (його малює lobby-ui.ts). */
export class Lobby extends EventTarget {
  #controller: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | 0 = 0;
  #running = false;
  #fetch: typeof fetch;
  #url: string;
  #intervalMs: number;
  #timeoutMs: number;

  rooms: LobbyRoom[] = [];
  playerName = '';

  constructor({ url = ROOMS_URL, intervalMs = 4000, timeoutMs = 3000, fetch: fetchImpl = (...args) => globalThis.fetch(...args) }: LobbyOptions = {}) {
    super();
    this.#url = url;
    this.#intervalMs = intervalMs;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl;
  }

  get running(): boolean {
    return this.#running;
  }

  get pending(): boolean {
    return this.#controller !== null;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.#intervalMs);
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = 0;
    this.#controller?.abort();
    this.#controller = null;
  }

  async refresh(): Promise<void> {
    this.#controller?.abort();

    const controller = new AbortController();
    this.#controller = controller;
    this.dispatchEvent(new CustomEvent('loading'));

    try {
      const data = await fetchJson(this.#url, { signal: controller.signal, timeoutMs: this.#timeoutMs, fetch: this.#fetch });
      const rooms = parseRooms(data);
      if (controller.signal.aborted) return;
      this.rooms = rooms;
      this.dispatchEvent(new CustomEvent('roomsChanged', { detail: rooms }));
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    } finally {
      if (this.#controller === controller) this.#controller = null;
    }
  }

  join(roomId: string): JoinedDetail {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new Error(`Кімнату "${roomId}" не знайдено`);
    if (room.players >= room.maxPlayers) throw new Error(`Кімната "${room.name}" заповнена`);

    const name = normalizeName(this.playerName);
    this.stop();

    const detail: JoinedDetail = { room, name, arena: room.arena };
    this.dispatchEvent(new CustomEvent('joined', { detail }));
    return detail;
  }
}
