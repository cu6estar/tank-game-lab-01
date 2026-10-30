import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { server as msg } from './protocol.ts';
import type { Match } from './match.ts';
import type { MatchLogEvent, Player, RoomArena, SendOptions } from './types.ts';

const newSeed = (): number => randomBytes(4).readUInt32LE() || 1;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type RoomErrorCode = 'full' | 'duplicate' | 'not_found' | 'limit';

export class RoomError extends Error {
  readonly code: RoomErrorCode;
  constructor(code: RoomErrorCode, message: string) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

export interface RosterEntry {
  readonly id: string;
  readonly name: string;
  readonly slot: number;
}

export interface RoomSummary {
  readonly id: string;
  readonly name: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly arena: RoomArena;
}

export interface RoomOptions {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers?: number;
  readonly arena?: RoomArena;
  readonly permanent?: boolean;
  readonly now?: () => number;
}

/** Події кімнати: назва → кортеж аргументів слухача. */
export interface RoomEventMap {
  open: [];
  join: [Player];
  leave: [Player];
  chat: [Player, string];
  event: [MatchLogEvent];
  empty: [];
}

// Типізовані перевантаження поверх EventEmitter (через злиття оголошень).
export interface Room {
  on<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): this;
  once<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): this;
  off<K extends keyof RoomEventMap>(event: K, listener: (...args: RoomEventMap[K]) => void): this;
  emit<K extends keyof RoomEventMap>(event: K, ...args: RoomEventMap[K]): boolean;
}

/**
 * Кімната. Нічого не знає про сокети: гравець — це Player з методом send(),
 * тож кімнату можна тестувати без мережі, а транспорт замінити на інший.
 *
 * Події (синхронні): 'open' (перший гравець), 'join', 'leave', 'chat',
 * 'event' (рядок логу матчу), 'empty' (останній вийшов). 'error' кімната НЕ
 * емітить — помилки (повна, дубль) це виняток із join(), який ловить викликач.
 */
export class Room extends EventEmitter {
  readonly players = new Map<string, Player>();
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: RoomArena;
  readonly permanent: boolean;
  readonly now: () => number;
  seed: number = newSeed(); // насіння ГПВЧ матчу; нове після кожного спорожніння
  match: Match | null = null; // виставляє менеджер матчів

  constructor({ id, name, maxPlayers = 8, arena = {}, permanent = false, now = Date.now }: RoomOptions) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.permanent = permanent; // кімнати "за замовчуванням" не видаляються, коли порожні
    this.now = now;
  }

  get size(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  join(player: Player): void {
    if (this.players.has(player.id)) {
      throw new RoomError('duplicate', 'Гравець уже в кімнаті');
    }
    if (this.isFull) {
      throw new RoomError('full', `Кімната "${this.name}" заповнена`);
    }

    const wasEmpty = this.players.size === 0;
    player.slot = this.#freeSlot();
    this.players.set(player.id, player);

    // 'open' раніше за 'event': слухач логу підписується в 'open' і встигає
    // побачити саме цей join першим рядком матчу
    if (wasEmpty) this.emit('open');
    this.#record('join', { player: { id: player.id, name: player.name } });
    this.emit('join', player);
    this.broadcast(msg.roster(this.roster()));
  }

  leave(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    this.players.delete(playerId);
    this.#record('leave', { player: { id: player.id, name: player.name } });
    this.emit('leave', player);
    this.broadcast(msg.roster(this.roster()));

    if (this.players.size === 0) {
      this.seed = newSeed();
      this.emit('empty');
    }
    return true;
  }

  chat(playerId: string, text: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;

    const t = this.now();
    this.#record('chat', { player: { id: player.id, name: player.name }, text });
    this.emit('chat', player, text);
    // чат — "некритичне" повідомлення: повільному клієнту його можна не слати
    this.broadcast(msg.chat({ id: player.id, name: player.name }, text, t), { critical: false });
    return true;
  }

  roster(): RosterEntry[] {
    return [...this.players.values()].map(({ id, name, slot }) => ({ id, name, slot }));
  }

  broadcast(message: unknown, options?: SendOptions): void {
    for (const player of this.players.values()) {
      try {
        player.send(message, options);
      } catch {
        // зламаний отримувач не повинен зупиняти розсилку іншим
      }
    }
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  #freeSlot(): number {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot += 1;
    return slot;
  }

  /** Запис у лог матчу (подія 'event'). */
  record(type: string, data: Record<string, unknown>): void {
    this.#record(type, data);
  }

  #record(type: string, data: Record<string, unknown>): void {
    this.emit('event', { t: this.now(), type, ...data });
  }
}

export interface SeedRoom {
  readonly id: string;
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: RoomArena;
}

export const SEED_ROOMS: readonly SeedRoom[] = [
  {
    id: 'training',
    name: 'Тренувальний полігон',
    maxPlayers: 8,
    arena: { enemies: 1, asteroids: 4, maxHomingAsteroids: 0, pickupIntervalSec: 6, maxPickups: 3 },
  },
  {
    id: 'belt',
    name: 'Астероїдний пояс',
    maxPlayers: 8,
    arena: {
      enemies: 2,
      asteroids: 12,
      maxHomingAsteroids: 4,
      homingChance: 0.5,
      pickupIntervalSec: 8,
      maxPickups: 2,
    },
  },
  {
    id: 'frontline',
    name: 'Лінія фронту',
    maxPlayers: 8,
    arena: { enemies: 4, asteroids: 5, maxHomingAsteroids: 1, pickupIntervalSec: 10, maxPickups: 2 },
  },
  {
    id: 'duel',
    name: 'Дуель',
    maxPlayers: 2,
    arena: { enemies: 1, asteroids: 2, maxHomingAsteroids: 0, pickupIntervalSec: 12, maxPickups: 1 },
  },
];

const ARENA_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
  enemies: [0, 20],
  asteroids: [0, 40],
  maxHomingAsteroids: [0, 20],
  pickupIntervalSec: [1, 120],
  maxPickups: [0, 10],
};

export interface RoomInputValue {
  readonly name: string;
  readonly maxPlayers: number;
  readonly arena: RoomArena;
}

export type RoomInputResult =
  | { ok: true; value: RoomInputValue }
  | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Перевірка тіла POST /api/rooms. Повертає або чисте значення, або список
 * помилок — нічого з тіла не потрапляє в кімнату "як є".
 */
export function validateRoomInput(
  body: unknown,
  { maxPlayersPerRoom }: { maxPlayersPerRoom: number },
): RoomInputResult {
  const errors: string[] = [];
  if (!isRecord(body)) {
    return { ok: false, errors: ["тіло має бути JSON-об'єктом"] };
  }

  const name = typeof body['name'] === 'string' ? body['name'].trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 40 || CONTROL_CHARS.test(name)) {
    errors.push('name: рядок 1–40 символів без керівних символів');
  }

  let maxPlayers = maxPlayersPerRoom;
  const rawMax = body['maxPlayers'];
  if (rawMax !== undefined) {
    if (typeof rawMax !== 'number' || !Number.isInteger(rawMax) || rawMax < 1 || rawMax > maxPlayersPerRoom) {
      errors.push(`maxPlayers: ціле 1–${maxPlayersPerRoom}`);
    } else {
      maxPlayers = rawMax;
    }
  }

  const arena: Record<string, number> = {};
  const rawArena = body['arena'];
  if (rawArena !== undefined) {
    if (!isRecord(rawArena)) {
      errors.push("arena: має бути об'єктом");
    } else {
      for (const [key, value] of Object.entries(rawArena)) {
        const limits = ARENA_LIMITS[key];
        if (!limits) {
          errors.push(`arena.${key}: невідоме поле`);
        } else if (typeof value !== 'number' || !Number.isInteger(value) || value < limits[0] || value > limits[1]) {
          errors.push(`arena.${key}: ціле ${limits[0]}–${limits[1]}`);
        } else {
          arena[key] = value;
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, maxPlayers, arena } };
}

export interface CreateRoomOptions {
  readonly id?: string;
  readonly name: string;
  readonly maxPlayers?: number;
  readonly arena?: RoomArena;
  readonly permanent?: boolean;
}

export interface RoomManager {
  on<K extends 'created' | 'deleted'>(event: K, listener: (room: Room) => void): this;
  emit<K extends 'created' | 'deleted'>(event: K, room: Room): boolean;
}

/**
 * Реєстр кімнат: створює, шукає й ВИДАЛЯЄ порожні (за подією 'empty').
 * Ліміт кількості кімнат — захист від клієнта, що спамить POST /api/rooms.
 */
export class RoomManager extends EventEmitter {
  #rooms = new Map<string, Room>();
  readonly maxRooms: number;
  readonly now: () => number;

  constructor({ maxRooms = 20, now = Date.now }: { maxRooms?: number; now?: () => number } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.now = now;
  }

  get size(): number {
    return this.#rooms.size;
  }

  create({ id, name, maxPlayers, arena, permanent = false }: CreateRoomOptions): Room {
    if (this.#rooms.size >= this.maxRooms) {
      throw new RoomError('limit', `Досягнуто ліміт кімнат (${this.maxRooms})`);
    }

    const roomId = id ?? `r-${randomBytes(3).toString('hex')}`;
    if (this.#rooms.has(roomId)) {
      throw new RoomError('duplicate', `Кімната "${roomId}" уже існує`);
    }

    const room = new Room({ id: roomId, name, maxPlayers, arena, permanent, now: this.now });
    this.#rooms.set(roomId, room);

    // Стрілка зберігає this менеджера; room.once не підходить, бо кімната
    // може наповнюватись і спорожніти багато разів (permanent)
    room.on('empty', () => {
      if (!room.permanent) this.delete(room.id);
    });

    this.emit('created', room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  delete(id: string): boolean {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    this.emit('deleted', room);
    return true;
  }

  list(): RoomSummary[] {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  [Symbol.iterator](): IterableIterator<Room> {
    return this.#rooms.values();
  }
}

export function seedRooms(manager: RoomManager): RoomManager {
  for (const seed of SEED_ROOMS) manager.create({ ...seed, permanent: true });
  return manager;
}
