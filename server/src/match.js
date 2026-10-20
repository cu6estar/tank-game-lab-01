import { performance } from 'node:perf_hooks';
import { getCodec } from '@tank/shared/codec/index.js';
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  DT,
  TICK_MS,
} from '@tank/shared/constants.js';
import { seqNewer } from '@tank/shared/protocol/input.js';
import {
  buildSnapshot,
  collectEvents,
} from '@tank/shared/protocol/snapshot.js';
import { Game } from '@tank/shared/sim/game.js';

/** Скільки кроків поспіль можна "надолужити" після затримки, перш ніж здатись. */
export const MAX_CATCHUP = 3;
/** Максимум непрочитаних вводів гравця: більше — це або лаг-спайк, або спід-хак. */
export const MAX_QUEUE = 10;
/** Якщо в черзі більше стільки вводів — пропускаємо один, щоб не копичити затримку. */
export const QUEUE_TARGET = 3;

const WINDOW = 120; // кроків у ковзному вікні статистики (4 с)

/**
 * Один матч = одна кімната. Сервер АВТОРИТЕТНИЙ: клієнти шлють лише ввід
 * (газ/поворот/вогонь + seq), а світ рахує тільки цей клас, у `Game` із shared/.
 *
 * Тікер: крок n має виконатись у момент `start + n·TICK_MS` (абсолютна ціль).
 * setInterval(33) цього не вміє: кожен тік запізнюється на кілька мс, і похибка
 * НАКОПИЧУЄТЬСЯ. Тут таймер лише будить нас, а наступну ціль рахуємо від start.
 */
export class Match {
  #timer = null;
  #startedAt = 0;
  #steps = 0;
  #inputs = new Map(); // slot → { queue: [], received, lastIntent }
  #cache = new Map(); // codec → кадр поточного знімка
  #durations = [];
  #lateness = [];

  constructor({
    room,
    seed,
    logger = console,
    now = () => performance.now(),
    onTick,
  } = {}) {
    this.room = room;
    this.seed = seed;
    this.logger = logger;
    this.now = now;
    this.onTick = onTick; // хук для тестів: імітація важкого кроку

    this.game = new Game({
      width: ARENA_WIDTH,
      height: ARENA_HEIGHT,
      seed,
      arena: room.arena,
    });
    this.game.start();
    this.events = collectEvents(this.game.world);

    this.counters = {
      overruns: 0,
      resyncs: 0,
      snapshots: 0,
      bytesOut: 0,
      lastSnapshotBytes: 0,
      encodeMicros: 0,
      rejectedInputs: 0,
      droppedInputs: 0,
      skippedInputs: 0,
      repeatedInputs: 0,
    };
  }

  get tick() {
    return this.game.tick;
  }

  // ---------------------------------------------------------- гравці

  addPlayer(player) {
    this.game.addPlayer(player.slot, { name: player.name });
    this.#inputs.set(player.slot, { queue: [], received: -1, hasInput: false });
  }

  removePlayer(player) {
    this.game.removePlayer(player.slot);
    this.#inputs.delete(player.slot);
  }

  /**
   * Приймає пакет вводів (до 3 останніх — "надлишковість" проти втрат пакетів).
   * Дублікати й старі seq відкидаємо, чергу обмежуємо.
   */
  receiveInputs(player, inputs) {
    const state = this.#inputs.get(player.slot);
    if (!state) return;

    for (const input of inputs) {
      if (state.hasInput && !seqNewer(input.seq, state.received)) continue; // дублікат/давній
      if (state.queue.length >= MAX_QUEUE) {
        this.counters.droppedInputs += 1;
        continue;
      }
      state.queue.push(input);
      state.received = input.seq;
      state.hasInput = true;
    }
  }

  queueLength(slot) {
    return this.#inputs.get(slot)?.queue.length ?? 0;
  }

  // ----------------------------------------------------------- цикл

  start() {
    if (this.#timer || this.stopped) return;
    this.#startedAt = this.now();
    this.#steps = 0;
    this.#schedule();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  get running() {
    return this.#timer !== null;
  }

  #target(n) {
    return this.#startedAt + n * TICK_MS;
  }

  #schedule() {
    const delay = Math.max(0, this.#target(this.#steps + 1) - this.now());
    this.#timer = setTimeout(() => this.#wake(), delay);
  }

  #wake() {
    if (this.stopped) return;
    this.#lateness.push(this.now() - this.#target(this.#steps + 1));

    let ran = 0;
    do {
      this.step();
      this.#steps += 1;
      ran += 1;
    } while (ran < MAX_CATCHUP && this.now() >= this.#target(this.#steps + 1));

    // Все ще позаду більш ніж на крок: наздоганяти далі = "спіраль смерті"
    // (кожен крок дорожчий за інтервал). Відпускаємо втрачений час.
    if (this.now() - this.#target(this.#steps + 1) > TICK_MS) {
      this.counters.overruns += 1;
      this.counters.resyncs += 1;
      this.#startedAt = this.now() - this.#steps * TICK_MS;
    }

    this.#trim();
    this.#schedule();
  }

  #trim() {
    if (this.#lateness.length > WINDOW)
      this.#lateness.splice(0, this.#lateness.length - WINDOW);
    if (this.#durations.length > WINDOW)
      this.#durations.splice(0, this.#durations.length - WINDOW);
  }

  /** Один крок симуляції + розсилка знімка. Публічний: тести викликають його без таймера. */
  step() {
    const began = this.now();

    for (const [slot, state] of this.#inputs) {
      // Черга розрослась (пачка пакетів після лагу): пропускаємо найстаріший ввід,
      // інакше затримка керування лишилась би назавжди.
      while (state.queue.length > QUEUE_TARGET) {
        state.queue.shift();
        this.counters.skippedInputs += 1;
      }
      const input = state.queue.shift();
      if (input) {
        this.game.setInput(slot, input.seq, input);
      } else if (state.hasInput) {
        this.counters.repeatedInputs += 1; // черга порожня: лишається попередній ввід
      }
    }

    this.onTick?.(this);
    this.game.step(DT);
    this.broadcast();

    this.#durations.push(this.now() - began);
  }

  broadcast() {
    const snapshot = buildSnapshot(this.game, this.events.drain());
    this.#cache.clear();

    for (const player of this.room.players.values()) {
      const codec = getCodec(player.codec ?? 'json');
      let frame = this.#cache.get(codec.name);
      if (!frame) {
        const t0 = performance.now();
        frame = codec.encodeSnapshot(snapshot);
        this.counters.encodeMicros += (performance.now() - t0) * 1000;
        this.#cache.set(codec.name, frame);
      }
      // знімок — повний стан: якщо клієнт повільний, пропущений не страшно
      if (player.sendFrame?.(frame, { critical: false })) {
        this.counters.bytesOut += frame.length ?? Buffer.byteLength(frame);
      }
    }
    this.counters.snapshots += 1;
    this.counters.lastSnapshotBytes =
      (this.#cache.values().next().value ?? []).length ?? 0;
  }

  stats() {
    const avg = (list) =>
      list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
    const max = (list) => list.reduce((a, b) => Math.max(a, b), 0);
    const round = (x) => Math.round(x * 100) / 100;
    return {
      room: this.room.id,
      tick: this.tick,
      players: this.room.size,
      tickMs: {
        avg: round(avg(this.#durations)),
        max: round(max(this.#durations)),
      },
      // lateness = на скільки мс таймер спрацював ПІЗНІШЕ за ціль (це і є jitter тіків)
      jitterMs: {
        avg: round(avg(this.#lateness)),
        max: round(max(this.#lateness)),
      },
      ...this.counters,
    };
  }
}
