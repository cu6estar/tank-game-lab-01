import { performance } from 'node:perf_hooks';
import { ZERO_SEQ } from '@tank/shared/brand.ts';
import type { Seq } from '@tank/shared/brand.ts';
import { getCodec, isCodecName } from '@tank/shared/codec/index.ts';
import { ARENA_HEIGHT, ARENA_WIDTH, DT, TICK_MS } from '@tank/shared/constants.ts';
import { seqNewer } from '@tank/shared/protocol/input.ts';
import { buildSnapshot, collectEvents } from '@tank/shared/protocol/snapshot.ts';
import type { EventCollector } from '@tank/shared/protocol/snapshot.ts';
import type { ClientInput, EncodedFrame } from '@tank/shared/protocol/types.ts';
import { Game } from '@tank/shared/sim/game.ts';
import type { Room } from './rooms.ts';
import type { Logger, Player } from './types.ts';

/** Скільки кроків поспіль можна "надолужити" після затримки, перш ніж здатись. */
export const MAX_CATCHUP = 3;
/** Максимум непрочитаних вводів гравця: більше — це або лаг-спайк, або спід-хак. */
export const MAX_QUEUE = 10;
/** Якщо в черзі більше стільки вводів — пропускаємо один, щоб не копичити затримку. */
export const QUEUE_TARGET = 3;

const WINDOW = 120; // кроків у ковзному вікні статистики (4 с)

interface InputState {
  queue: ClientInput[];
  received: Seq;
  hasInput: boolean;
}

interface Counters {
  overruns: number;
  resyncs: number;
  snapshots: number;
  bytesOut: number;
  lastSnapshotBytes: number;
  encodeMicros: number;
  rejectedInputs: number;
  droppedInputs: number;
  skippedInputs: number;
  repeatedInputs: number;
}

export interface MatchStats extends Counters {
  room: string;
  tick: number;
  players: number;
  tickMs: { avg: number; max: number };
  jitterMs: { avg: number; max: number };
}

export interface MatchOptions {
  readonly room: Room;
  readonly seed: number;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly onTick?: (match: Match) => void;
}

/**
 * Один матч = одна кімната. Сервер АВТОРИТЕТНИЙ: клієнти шлють лише ввід
 * (газ/поворот/вогонь + seq), а світ рахує тільки цей клас, у `Game` із shared/.
 *
 * Тікер: крок n має виконатись у момент `start + n·TICK_MS` (абсолютна ціль).
 * setInterval(33) цього не вміє: кожен тік запізнюється, і похибка НАКОПИЧУЄТЬСЯ.
 */
export class Match {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #startedAt = 0;
  #steps = 0;
  #inputs = new Map<number, InputState>();
  #cache = new Map<string, EncodedFrame>();
  #durations: number[] = [];
  #lateness: number[] = [];

  readonly room: Room;
  readonly seed: number;
  readonly logger: Logger;
  readonly now: () => number;
  onTick: ((match: Match) => void) | undefined;
  readonly game: Game;
  readonly events: EventCollector;
  stopped = false;

  readonly counters: Counters = {
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

  constructor({ room, seed, logger = console, now = () => performance.now(), onTick }: MatchOptions) {
    this.room = room;
    this.seed = seed;
    this.logger = logger;
    this.now = now;
    this.onTick = onTick; // хук для тестів: імітація важкого кроку

    this.game = new Game({ width: ARENA_WIDTH, height: ARENA_HEIGHT, seed, arena: room.arena });
    this.game.start();
    this.events = collectEvents(this.game.world);
  }

  get tick(): number {
    return this.game.tick;
  }

  // ---------------------------------------------------------- гравці

  addPlayer(player: Player): void {
    this.game.addPlayer(player.slot, { name: player.name });
    this.#inputs.set(player.slot, { queue: [], received: ZERO_SEQ, hasInput: false });
  }

  removePlayer(player: Player): void {
    this.game.removePlayer(player.slot);
    this.#inputs.delete(player.slot);
  }

  /**
   * Приймає пакет вводів (до 3 останніх — "надлишковість" проти втрат пакетів).
   * Дублікати й старі seq відкидаємо, чергу обмежуємо.
   */
  receiveInputs(player: Player, inputs: readonly ClientInput[]): void {
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

  queueLength(slot: number): number {
    return this.#inputs.get(slot)?.queue.length ?? 0;
  }

  // ----------------------------------------------------------- цикл

  start(): void {
    if (this.#timer || this.stopped) return;
    this.#startedAt = this.now();
    this.#steps = 0;
    this.#schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  #target(n: number): number {
    return this.#startedAt + n * TICK_MS;
  }

  #schedule(): void {
    const delay = Math.max(0, this.#target(this.#steps + 1) - this.now());
    this.#timer = setTimeout(() => this.#wake(), delay);
  }

  #wake(): void {
    if (this.stopped) return;
    this.#lateness.push(this.now() - this.#target(this.#steps + 1));

    let ran = 0;
    do {
      this.step();
      this.#steps += 1;
      ran += 1;
    } while (ran < MAX_CATCHUP && this.now() >= this.#target(this.#steps + 1));

    // Все ще позаду більш ніж на крок: наздоганяти далі = "спіраль смерті".
    if (this.now() - this.#target(this.#steps + 1) > TICK_MS) {
      this.counters.overruns += 1;
      this.counters.resyncs += 1;
      this.#startedAt = this.now() - this.#steps * TICK_MS;
    }

    this.#trim();
    this.#schedule();
  }

  #trim(): void {
    if (this.#lateness.length > WINDOW) this.#lateness.splice(0, this.#lateness.length - WINDOW);
    if (this.#durations.length > WINDOW) this.#durations.splice(0, this.#durations.length - WINDOW);
  }

  /** Один крок симуляції + розсилка знімка. Публічний: тести викликають його без таймера. */
  step(): void {
    const began = this.now();

    for (const [slot, state] of this.#inputs) {
      // Черга розрослась (пачка пакетів після лагу): пропускаємо найстаріший ввід.
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

  broadcast(): void {
    const snapshot = buildSnapshot(this.game, this.events.drain());
    this.#cache.clear();

    for (const player of this.room.players.values()) {
      const codecName = player.codec && isCodecName(player.codec) ? player.codec : 'json';
      const codec = getCodec(codecName);
      let frame = this.#cache.get(codec.name);
      if (!frame) {
        const t0 = performance.now();
        frame = codec.encodeSnapshot(snapshot);
        this.counters.encodeMicros += (performance.now() - t0) * 1000;
        this.#cache.set(codec.name, frame);
      }
      // знімок — повний стан: якщо клієнт повільний, пропущений не страшно
      if (player.sendFrame?.(frame, { critical: false })) {
        this.counters.bytesOut += frame.length;
      }
    }
    this.counters.snapshots += 1;
    this.counters.lastSnapshotBytes = this.#cache.values().next().value?.length ?? 0;
  }

  stats(): MatchStats {
    const avg = (list: number[]): number => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
    const max = (list: number[]): number => list.reduce((a, b) => Math.max(a, b), 0);
    const round = (x: number): number => Math.round(x * 100) / 100;
    return {
      room: this.room.id,
      tick: this.tick,
      players: this.room.size,
      tickMs: { avg: round(avg(this.#durations)), max: round(max(this.#durations)) },
      // lateness = на скільки мс таймер спрацював ПІЗНІШЕ за ціль (це і є jitter тіків)
      jitterMs: { avg: round(avg(this.#lateness)), max: round(max(this.#lateness)) },
      ...this.counters,
    };
  }
}
