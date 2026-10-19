import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { server as msg } from './protocol.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code; // 'full' | 'duplicate' | 'not_found' | 'limit'
  }
}

/**
 * Кімната. Нічого не знає про сокети: гравець — це { id, name, send(message, opts) },
 * тож кімнату можна тестувати без мережі, а транспорт замінити на інший.
 *
 * Події (синхронні, слухачі викликаються в порядку підписки):
 *   'open'   у порожню кімнату зайшов перший гравець (почався "матч" — можна вести лог)
 *   'join'   (player)
 *   'leave'  (player)
 *   'chat'   (player, text)
 *   'event'  ({ t, type, ... }) — усе, що має потрапити в лог матчу
 *   'empty'  вийшов останній гравець
 *
 * 'error' кімната НЕ емітить: помилки (повна кімната, дубль) — це виняток із
 * join(), який обробляє викликач. EventEmitter без слухача 'error' валить процес,
 * тому ми не використовуємо 'error' для штатних ситуацій.
 */
export class Room extends EventEmitter {
  players = new Map();

  constructor({
    id,
    name,
    maxPlayers = 8,
    arena = {},
    permanent = false,
    now = Date.now,
  }) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.permanent = permanent; // кімнати "за замовчуванням" не видаляються, коли порожні
    this.now = now;
  }

  get size() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= this.maxPlayers;
  }

  join(player) {
    if (this.players.has(player.id)) {
      throw new RoomError('duplicate', 'Гравець уже в кімнаті');
    }
    if (this.isFull) {
      throw new RoomError('full', `Кімната "${this.name}" заповнена`);
    }

    const wasEmpty = this.players.size === 0;
    this.players.set(player.id, player);

    // 'open' раніше за 'event': слухач логу підписується в 'open' і встигає
    // побачити саме цей join першим рядком матчу
    if (wasEmpty) this.emit('open');
    this.#record('join', { player: { id: player.id, name: player.name } });
    this.emit('join', player);
    this.broadcast(msg.roster(this.roster()));
  }

  leave(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;

    this.players.delete(playerId);
    this.#record('leave', { player: { id: player.id, name: player.name } });
    this.emit('leave', player);
    this.broadcast(msg.roster(this.roster()));

    if (this.players.size === 0) this.emit('empty');
    return true;
  }

  chat(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return false;

    const t = this.now();
    this.#record('chat', {
      player: { id: player.id, name: player.name },
      text,
    });
    this.emit('chat', player, text);
    // чат — "некритичне" повідомлення: повільному клієнту його можна не слати
    this.broadcast(msg.chat({ id: player.id, name: player.name }, text, t), {
      critical: false,
    });
    return true;
  }

  roster() {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  broadcast(message, options) {
    for (const player of this.players.values()) {
      try {
        player.send(message, options);
      } catch {
        // зламаний отримувач не повинен зупиняти розсилку іншим
      }
    }
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      players: this.players.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  #record(type, data) {
    this.emit('event', { t: this.now(), type, ...data });
  }
}

export const SEED_ROOMS = [
  {
    id: 'training',
    name: 'Тренувальний полігон',
    maxPlayers: 8,
    arena: {
      enemies: 1,
      asteroids: 4,
      maxHomingAsteroids: 0,
      pickupIntervalSec: 6,
      maxPickups: 3,
    },
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
    arena: {
      enemies: 4,
      asteroids: 5,
      maxHomingAsteroids: 1,
      pickupIntervalSec: 10,
      maxPickups: 2,
    },
  },
  {
    id: 'duel',
    name: 'Дуель',
    maxPlayers: 2,
    arena: {
      enemies: 1,
      asteroids: 2,
      maxHomingAsteroids: 0,
      pickupIntervalSec: 12,
      maxPickups: 1,
    },
  },
];

const ARENA_LIMITS = {
  enemies: [0, 20],
  asteroids: [0, 40],
  maxHomingAsteroids: [0, 20],
  pickupIntervalSec: [1, 120],
  maxPickups: [0, 10],
};

/**
 * Перевірка тіла POST /api/rooms. Повертає або чисте значення, або список
 * помилок — нічого з тіла не потрапляє в кімнату "як є".
 */
export function validateRoomInput(body, { maxPlayersPerRoom }) {
  const errors = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ["тіло має бути JSON-об'єктом"] };
  }

  const name =
    typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 40 || CONTROL_CHARS.test(name)) {
    errors.push('name: рядок 1–40 символів без керівних символів');
  }

  let maxPlayers = maxPlayersPerRoom;
  if (body.maxPlayers !== undefined) {
    if (
      !Number.isInteger(body.maxPlayers) ||
      body.maxPlayers < 1 ||
      body.maxPlayers > maxPlayersPerRoom
    ) {
      errors.push(`maxPlayers: ціле 1–${maxPlayersPerRoom}`);
    } else {
      maxPlayers = body.maxPlayers;
    }
  }

  const arena = {};
  if (body.arena !== undefined) {
    if (
      body.arena === null ||
      typeof body.arena !== 'object' ||
      Array.isArray(body.arena)
    ) {
      errors.push("arena: має бути об'єктом");
    } else {
      for (const [key, value] of Object.entries(body.arena)) {
        const limits = ARENA_LIMITS[key];
        if (!limits) {
          errors.push(`arena.${key}: невідоме поле`);
        } else if (
          !Number.isInteger(value) ||
          value < limits[0] ||
          value > limits[1]
        ) {
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

/**
 * Реєстр кімнат: створює, шукає й ВИДАЛЯЄ порожні (за подією 'empty').
 * Ліміт кількості кімнат — захист від клієнта, що спамить POST /api/rooms.
 */
export class RoomManager extends EventEmitter {
  #rooms = new Map();

  constructor({ maxRooms = 20, now = Date.now } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.now = now;
  }

  get size() {
    return this.#rooms.size;
  }

  create({ id, name, maxPlayers, arena, permanent = false }) {
    if (this.#rooms.size >= this.maxRooms) {
      throw new RoomError('limit', `Досягнуто ліміт кімнат (${this.maxRooms})`);
    }

    const roomId = id ?? `r-${randomBytes(3).toString('hex')}`;
    if (this.#rooms.has(roomId)) {
      throw new RoomError('duplicate', `Кімната "${roomId}" уже існує`);
    }

    const room = new Room({
      id: roomId,
      name,
      maxPlayers,
      arena,
      permanent,
      now: this.now,
    });
    this.#rooms.set(roomId, room);

    // Стрілка зберігає this менеджера; room.once не підходить, бо кімната
    // може наповнюватись і спорожніти багато разів (permanent)
    room.on('empty', () => {
      if (!room.permanent) this.delete(room.id);
    });

    this.emit('created', room);
    return room;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    this.emit('deleted', room);
    return true;
  }

  list() {
    return [...this.#rooms.values()].map((room) => room.summary());
  }

  [Symbol.iterator]() {
    return this.#rooms.values();
  }
}

export function seedRooms(manager) {
  for (const seed of SEED_ROOMS) manager.create({ ...seed, permanent: true });
  return manager;
}
