import { TICK_MS } from '@tank/shared/constants.js';

/**
 * Буфер знімків для інтерполяції "в минулому" (entity interpolation).
 *
 * ЧАС. Годинники клієнта й сервера не збігаються, тож шкалою часу є номер
 * тіка: серверний час знімка = tick · TICK_MS. Зсув між годинниками
 * оцінюємо як МІНІМУМ (arrival − tickTime) за останні ~5 с: найшвидший
 * пакет майже не затримався в мережі, тож він показує "справжній" зсув, а
 * решта пакетів — це зсув + їхня затримка. Мінімум стійкий до jitter-піків
 * (середнє б "пливло" разом із ними).
 *
 * Тоді "серверний час зараз" = now − offset, а малюємо момент
 * `now − offset − delay`: на delay мс у минулому. Туди вже встигли дійти
 * принаймні два знімки, і між ними можна плавно інтерполювати.
 */
export class SnapshotBuffer {
  #items = []; // { snapshot, tickMs, arrival }, за зростанням tick
  #samples = []; // arrival − tickMs для останніх знімків

  constructor({ capacity = 64, windowSize = 150 } = {}) {
    this.capacity = capacity;
    this.windowSize = windowSize;
    this.stats = { received: 0, duplicate: 0, late: 0 };
  }

  get size() {
    return this.#items.length;
  }

  get newest() {
    return this.#items.at(-1)?.snapshot ?? null;
  }

  get newestArrival() {
    return this.#items.at(-1)?.arrival ?? 0;
  }

  /** Зсув годинників, мс; null, поки знімків не було. */
  get offset() {
    return this.#samples.length ? Math.min(...this.#samples) : null;
  }

  /**
   * @returns {'ok'|'duplicate'|'late'} 'late' — знімок старіший за вже відомі
   * (прийшов поза чергою) і в буфер не потрапляє: історію переписувати нікому.
   */
  push(snapshot, arrival) {
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
  serverTime(now) {
    const offset = this.offset;
    return offset === null ? null : now - offset;
  }

  /**
   * Пара знімків навколо `timeMs` і частка alpha між ними.
   * @returns {{a, b, alpha, starved}|null}
   *   starved = true, якщо потрібний час уже ПІСЛЯ останнього знімка
   *   (нові не встигли): тримаємо останній, а не екстраполюємо.
   */
  sample(timeMs) {
    const items = this.#items;
    if (items.length === 0) return null;

    const first = items[0];
    const last = items.at(-1);
    if (timeMs <= first.tickMs) {
      return { a: first.snapshot, b: first.snapshot, alpha: 0, starved: false };
    }
    if (timeMs >= last.tickMs) {
      return {
        a: last.snapshot,
        b: last.snapshot,
        alpha: 0,
        starved: timeMs > last.tickMs,
      };
    }

    for (let i = items.length - 1; i > 0; i--) {
      const a = items[i - 1];
      const b = items[i];
      if (timeMs >= a.tickMs) {
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

  clear() {
    this.#items.length = 0;
    this.#samples.length = 0;
  }
}
