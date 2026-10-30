/**
 * Token bucket: у відрі до `capacity` жетонів, поповнення `ratePerSec` жетонів
 * за секунду. Кожне повідомлення коштує один жетон. Дає короткі сплески
 * (до capacity), але не дозволяє тримати швидкість вище за ratePerSec.
 * Годинник інжектується, тож тест не спить реальні секунди.
 */
export interface TokenBucketOptions {
  readonly capacity: number;
  readonly ratePerSec: number;
  readonly now?: () => number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly ratePerSec: number;
  readonly now: () => number;
  #tokens: number;
  #last: number;

  constructor({ capacity, ratePerSec, now = () => performance.now() }: TokenBucketOptions) {
    this.capacity = capacity;
    this.ratePerSec = ratePerSec;
    this.now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  /** @returns true — повідомлення дозволено */
  take(cost = 1): boolean {
    const t = this.now();
    const elapsedSec = Math.max(0, (t - this.#last) / 1000);
    this.#last = t;
    this.#tokens = Math.min(this.capacity, this.#tokens + elapsedSec * this.ratePerSec);

    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }

  get tokens(): number {
    return this.#tokens;
  }
}
