/**
 * Інжектор мережевих умов: затримка, jitter і втрата пакетів. Працює на клієнті,
 * на ОБОХ шляхах (відправка вводу і приймання знімків), тож сервер лишається
 * чесним Node-процесом, а умови "поганого Wi-Fi" відтворюються у браузері.
 *
 * Порядок на кожному напрямку зберігається (як у TCP/WebSocket): пакет, якому
 * випало менше затримки, чекає попередній (head-of-line blocking).
 * Втрати (drop) — незалежні й безповоротні, як у UDP.
 */
export type LagKey = 'lag' | 'jitter' | 'drop';
export type LagConfig = Record<LagKey, number>;
export type LagChannel = 'in' | 'out';
export type PassResult = 'now' | 'later' | 'dropped';

export const LAG_LIMITS: Record<LagKey, readonly [number, number]> = {
  lag: [0, 2000],
  jitter: [0, 1000],
  drop: [0, 100],
};

const clamp = (value: number, [min, max]: readonly [number, number]): number =>
  Math.min(max, Math.max(min, value));

export interface LagTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface LagInjectorOptions {
  readonly config?: Partial<Record<LagKey, number | string | undefined>>;
  readonly random?: () => number;
  readonly timers?: LagTimers;
}

export interface LagInjector {
  readonly config: LagConfig;
  readonly active: boolean;
  readonly stats: { passed: number; dropped: number; delayed: number };
  configure(next?: Partial<Record<LagKey, number | string | undefined>>): LagConfig;
  configureFromQuery(search: string): LagConfig;
  pass(fn: () => void, channel?: LagChannel): PassResult;
  clear(): void;
}

const defaultTimers: LagTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

export function createLagInjector({ config = {}, random = Math.random, timers = defaultTimers }: LagInjectorOptions = {}): LagInjector {
  const state: LagConfig = { lag: 0, jitter: 0, drop: 0 };
  const pending = new Set<unknown>();
  const lastDue: Record<LagChannel, number> = { in: 0, out: 0 };
  const stats = { passed: 0, dropped: 0, delayed: 0 };

  function configure(next?: Partial<Record<LagKey, number | string | undefined>>): LagConfig {
    for (const key of Object.keys(LAG_LIMITS) as LagKey[]) {
      const raw = next?.[key];
      const value = Number(raw);
      if (next && key in next && Number.isFinite(value)) {
        state[key] = clamp(value, LAG_LIMITS[key]);
      }
    }
    return { ...state };
  }
  configure(config);

  function configureFromQuery(search: string): LagConfig {
    const params = new URLSearchParams(search);
    return configure({
      lag: params.get('lag') ?? undefined,
      jitter: params.get('jitter') ?? undefined,
      drop: params.get('drop') ?? undefined,
    });
  }

  function pass(fn: () => void, channel: LagChannel = 'out'): PassResult {
    if (random() * 100 < state.drop) {
      stats.dropped += 1;
      return 'dropped';
    }
    const now = timers.now();
    const wanted = state.lag / 2 + (random() * 2 - 1) * state.jitter;
    // не обганяємо попередній пакет цього напрямку (як TCP): head-of-line blocking
    const due = Math.max(now + Math.max(0, wanted), lastDue[channel]);
    lastDue[channel] = due;
    const delay = due - now;
    if (delay <= 0) {
      stats.passed += 1;
      fn();
      return 'now';
    }
    stats.delayed += 1;
    const timer = timers.setTimeout(() => {
      pending.delete(timer);
      stats.passed += 1;
      fn();
    }, delay);
    pending.add(timer);
    return 'later';
  }

  return {
    get config(): LagConfig {
      return { ...state };
    },
    get active(): boolean {
      return state.lag > 0 || state.jitter > 0 || state.drop > 0;
    },
    stats,
    configure,
    configureFromQuery,
    pass,
    clear(): void {
      for (const timer of pending) timers.clearTimeout(timer);
      pending.clear();
    },
  };
}
