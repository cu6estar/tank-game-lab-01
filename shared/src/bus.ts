/**
 * Типізована шина подій. `E` — карта "ім'я події → тип корисного навантаження":
 *
 *   interface GameEvents { scoreChanged: { slot: number; score: number } }
 *   const bus = new Bus<GameEvents>();
 *   bus.on('scoreChanged', (e) => e.score);   // e: { slot; score }
 *   bus.emit('scoreChanged', { slot: 1 });    // помилка: немає score
 *
 * `K extends keyof E` + `E[K]` зв'язують ім'я події з її даними: тип
 * обробника і тип аргументу `emit` виводяться з одного K. Події синхронні:
 * обробники викликаються в порядку підписки, помилка одного не зупиняє інших
 * (як у EventTarget).
 */
export type Handler<P> = (payload: P) => void;

export class Bus<E extends { [K in keyof E]: unknown }> {
  #handlers: { [K in keyof E]?: Set<Handler<E[K]>> } = {};

  /** Підписка; повертає функцію відписки. */
  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    const set = this.#handlers[type] ?? new Set<Handler<E[K]>>();
    this.#handlers[type] = set;
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.#handlers[type];
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error: unknown) {
        console.error(`[bus] обробник "${String(type)}" упав:`, error);
      }
    }
  }

  /** Кількість підписників (для тестів на витоки). */
  listenerCount<K extends keyof E>(type: K): number {
    return this.#handlers[type]?.size ?? 0;
  }

  clear(): void {
    this.#handlers = {};
  }
}
