import { TICK_MS } from '@tank/shared/constants.ts';
import type { Snapshot } from '@tank/shared/protocol/types.ts';

interface BufferedSnapshot {
  readonly snapshot: Snapshot;
  readonly tickMs: number;
  readonly arrival: number;
}

export type PushResult = 'ok' | 'duplicate' | 'late';

export interface SnapshotSample {
  readonly a: Snapshot;
  readonly b: Snapshot;
  readonly alpha: number;
  readonly starved: boolean;
}

export interface SnapshotBufferOptions {
  readonly capacity?: number;
  readonly windowSize?: number;
}

/**
 * Буфер знімків для інтерполяції "в минулому" (entity interpolation).
 *
 * ЧАС. Годинники клієнта й сервера не збігаються, тож шкалою часу є номер тіка:
 * серверний час знімка = tick · TICK_MS. Зсув між годинниками оцінюємо як
 * МІНІМУМ (arrival − tickTime) за останні ~5 с: найшвидший пакет майже не
 * затримався, тож показує "справжній" зсув. Малюємо момент `now − offset − delay`.
 */
export class SnapshotBuffer {
  #items: BufferedSnapshot[] = []; // за зростанням tick
  #samples: number[] = []; // arrival − tickMs для останніх знімків
  readonly capacity: number;
  readonly windowSize: number;
  readonly stats = { received: 0, duplicate: 0, late: 0 };

  constructor({ capacity = 64, windowSize = 150 }: SnapshotBufferOptions = {}) {
    this.capacity = capacity;
    this.windowSize = windowSize;
  }

  get size(): number {
    return this.#items.length;
  }

  get newest(): Snapshot | null {
    return this.#items.at(-1)?.snapshot ?? null;
  }

  get newestArrival(): number {
    return this.#items.at(-1)?.arrival ?? 0;
  }

  /** Зсув годинників, мс; null, поки знімків не було. */
  get offset(): number | null {
    return this.#samples.length ? Math.min(...this.#samples) : null;
  }

  /** 'late' — знімок старіший за вже відомі; у буфер не потрапляє. */
  push(snapshot: Snapshot, arrival: number): PushResult {
    const tickMs = snapshot.tick * TICK_MS;
    const newest = this.#items.at(-1);

    if (newest && snapshot.tick === newest.snapshot.tick) {
      this.stats.duplicate += 1;
      return 'duplicate';
    }
    if (newest && snapshot.tick < newest.snapshot.tick) {
      this.stats.late += 1;
      return 'late';
    }

    this.stats.received += 1;
    this.#items.push({ snapshot, tickMs, arrival });
    if (this.#items.length > this.capacity) this.#items.shift();

    this.#samples.push(arrival - tickMs);
    if (this.#samples.length > this.windowSize) this.#samples.shift();
    return 'ok';
  }

  /** Серверний час (мс шкали тіків), що відповідає моменту `now` клієнта. */
  serverTime(now: number): number | null {
    const offset = this.offset;
    return offset === null ? null : now - offset;
  }

  /**
   * Пара знімків навколо `timeMs` і частка alpha між ними.
   * starved = true, якщо потрібний час уже ПІСЛЯ останнього знімка.
   */
  sample(timeMs: number): SnapshotSample | null {
    const items = this.#items;
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) return null;

    if (timeMs <= first.tickMs) {
      return { a: first.snapshot, b: first.snapshot, alpha: 0, starved: false };
    }
    if (timeMs >= last.tickMs) {
      return { a: last.snapshot, b: last.snapshot, alpha: 0, starved: timeMs > last.tickMs };
    }

    for (let i = items.length - 1; i > 0; i--) {
      const a = items[i - 1];
      const b = items[i];
      if (a !== undefined && b !== undefined && timeMs >= a.tickMs) {
        return {
          a: a.snapshot,
          b: b.snapshot,
          alpha: (timeMs - a.tickMs) / (b.tickMs - a.tickMs),
          starved: false,
        };
      }
    }
    return null; // недосяжно
  }

  clear(): void {
    this.#items.length = 0;
    this.#samples.length = 0;
  }
}
