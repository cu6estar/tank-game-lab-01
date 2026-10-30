/** Лічильник байтів/подій за ковзне вікно (для bytes/s і snapshots/s у netgraph). */
export class RateMeter {
  #events: [number, number][] = []; // [timeMs, amount]
  readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  add(amount: number, now: number): void {
    this.#events.push([now, amount]);
    this.#trim(now);
  }

  #trim(now: number): void {
    const cutoff = now - this.windowMs;
    let head = this.#events[0];
    while (head !== undefined && head[0] < cutoff) {
      this.#events.shift();
      head = this.#events[0];
    }
  }

  /** Сума за вікно, перерахована на секунду. */
  perSecond(now: number): number {
    this.#trim(now);
    const total = this.#events.reduce((sum, [, amount]) => sum + amount, 0);
    return (total * 1000) / this.windowMs;
  }
}

export interface SmoothedOptions {
  readonly alpha?: number;
  readonly windowMs?: number;
}

/** Експоненційне згладжування + останнє значення + максимум за вікно. */
export class Smoothed {
  #history: [number, number][] = []; // [timeMs, value]
  readonly alpha: number;
  readonly windowMs: number;
  value: number | null = null;
  last: number | null = null;

  constructor({ alpha = 0.2, windowMs = 2000 }: SmoothedOptions = {}) {
    this.alpha = alpha;
    this.windowMs = windowMs;
  }

  add(sample: number, now: number): void {
    this.last = sample;
    this.value = this.value === null ? sample : this.value + (sample - this.value) * this.alpha;
    this.#history.push([now, sample]);
    const cutoff = now - this.windowMs;
    let head = this.#history[0];
    while (head !== undefined && head[0] < cutoff) {
      this.#history.shift();
      head = this.#history[0];
    }
  }

  max(now: number): number {
    const cutoff = now - this.windowMs;
    return this.#history.reduce((m, [t, v]) => (t >= cutoff ? Math.max(m, v) : m), 0);
  }
}
