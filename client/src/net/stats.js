/** Лічильник байтів/подій за ковзне вікно (для bytes/s і snapshots/s у netgraph). */
export class RateMeter {
  #events = []; // [timeMs, amount]

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  add(amount, now) {
    this.#events.push([now, amount]);
    this.#trim(now);
  }

  #trim(now) {
    const cutoff = now - this.windowMs;
    while (this.#events.length > 0 && this.#events[0][0] < cutoff)
      this.#events.shift();
  }

  /** Сума за вікно, перерахована на секунду. */
  perSecond(now) {
    this.#trim(now);
    const total = this.#events.reduce((sum, [, amount]) => sum + amount, 0);
    return (total * 1000) / this.windowMs;
  }
}

/** Експоненційне згладжування + останнє значення + максимум за вікно. */
export class Smoothed {
  #history = []; // [timeMs, value]

  constructor({ alpha = 0.2, windowMs = 2000 } = {}) {
    this.alpha = alpha;
    this.windowMs = windowMs;
    this.value = null;
    this.last = null;
  }

  add(sample, now) {
    this.last = sample;
    this.value =
      this.value === null
        ? sample
        : this.value + (sample - this.value) * this.alpha;
    this.#history.push([now, sample]);
    const cutoff = now - this.windowMs;
    while (this.#history.length > 0 && this.#history[0][0] < cutoff)
      this.#history.shift();
  }

  max(now) {
    const cutoff = now - this.windowMs;
    return this.#history.reduce(
      (m, [t, v]) => (t >= cutoff ? Math.max(m, v) : m),
      0,
    );
  }
}
