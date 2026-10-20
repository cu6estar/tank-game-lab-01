/**
 * Інжектор мережевих умов: затримка, jitter і втрата пакетів. Працює на клієнті,
 * на ОБОХ шляхах (відправка вводу і приймання знімків), тож сервер лишається
 * чесним Node-процесом, а умови "поганого Wi-Fi" відтворюються у браузері.
 *
 *   lag    — додаткова затримка RTT, мс (по lag/2 на кожен напрямок)
 *   jitter — ±випадкове відхилення КОЖНОГО пакета, мс (на кожному напрямку)
 *   drop   — відсоток втрачених пакетів, 0–100 (на кожному напрямку)
 *
 * Порядок на кожному напрямку зберігається (як у TCP/WebSocket): пакет, якому
 * випало менше затримки, чекає попередній — це "head-of-line blocking", через
 * який у реальній мережі jitter виглядає як пачки пакетів, що приходять разом.
 * Втрати (drop) — незалежні й безповоротні, як у UDP.
 *
 * Керування: ?lag=100&jitter=30&drop=2 в URL, або вживу через window.__net.lag.
 */
export const LAG_LIMITS = { lag: [0, 2000], jitter: [0, 1000], drop: [0, 100] };

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));

export function createLagInjector({
  config = {},
  random = Math.random,
  timers = {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (t) => globalThis.clearTimeout(t),
    now: () => performance.now(),
  },
} = {}) {
  const state = { lag: 0, jitter: 0, drop: 0 };
  const pending = new Set();
  const lastDue = { in: 0, out: 0 }; // коли вийде останній пакет кожного напрямку
  const stats = { passed: 0, dropped: 0, delayed: 0 };

  function configure(next) {
    for (const key of Object.keys(LAG_LIMITS)) {
      const value = Number(next?.[key]);
      if (next && key in next && Number.isFinite(value)) {
        state[key] = clamp(value, LAG_LIMITS[key]);
      }
    }
    return { ...state };
  }
  configure(config);

  /** Читає ?lag=&jitter=&drop= (будь-яке може бути відсутнє). */
  function configureFromQuery(search) {
    const params = new URLSearchParams(search);
    return configure({
      lag: params.get('lag') ?? undefined,
      jitter: params.get('jitter') ?? undefined,
      drop: params.get('drop') ?? undefined,
    });
  }

  /**
   * Пропускає дію `fn` через інжектор: виконує зараз, пізніше або ніколи.
   * Повертає 'now' | 'later' | 'dropped'.
   */
  function pass(fn, channel = 'out') {
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
    get config() {
      return { ...state };
    },
    get active() {
      return state.lag > 0 || state.jitter > 0 || state.drop > 0;
    },
    stats,
    configure,
    configureFromQuery,
    pass,
    /** Скасувати все, що ще "летить" (при виході з гри). */
    clear() {
      for (const timer of pending) timers.clearTimeout(timer);
      pending.clear();
    },
  };
}
