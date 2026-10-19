/**
 * Обгортка над WebSocket: диспетчер за `type`, черга send() і перепідключення.
 *
 * Браузерний WebSocket "сирий": send() до відкриття кидає InvalidStateError,
 * обрив мережі — це просто подія close, нічого не повторюється саме. Обгортка
 * додає:
 *   — on(type, handler): повідомлення розходяться за полем `type`, а не одним
 *     великим switch у кожному споживачі;
 *   — чергу: send() до відкриття (або під час перепідключення) не губить
 *     повідомлення, а кладе їх у чергу й віддає після рукостискання;
 *   — перепідключення з дедалі довшою паузою (exponential backoff + jitter);
 *   — handshake(): повідомлення, яке завжди йде ПЕРШИМ після кожного (пере)підключення
 *     — для нас це join, тож після обриву гравець сам повертається в кімнату.
 *
 * Життєвий цикл повідомляється подіями (EventTarget): 'open', 'close',
 * 'reconnecting' { attempt, delayMs, code }, 'fatal' { code, reason },
 * 'statechange' { state }, 'protocolerror' { raw }.
 */

const OPEN = 1; // WebSocket.OPEN: не залежимо від глобальної змінної (тестам підставляється фейк)

/** Коди, після яких повторювати марно: сервер сказав "ні" свідомо. */
export const DEFAULT_FATAL_CODES = new Set([
  1003, // text only
  1009, // завелике повідомлення
  4001, // bad message
  4002, // unknown type
  4003, // join rejected (немає кімнати / заповнена)
  4004, // rate limit
  4006, // bad version
]);

/**
 * Пауза перед спробою №attempt (з 1): стеля росте як base·2^(n−1) до maxMs,
 * а реальна пауза — випадкова в діапазоні [стеля/2, стеля] ("equal jitter").
 * Jitter потрібен, щоб після падіння сервера всі клієнти не вернулись одночасно.
 */
export function backoffDelay(
  attempt,
  { baseMs = 500, maxMs = 15_000, random = Math.random } = {},
) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export class Connection extends EventTarget {
  #url;
  #WebSocket;
  #handshake;
  #backoff;
  #maxQueue;
  #shouldReconnect;
  #timers;
  #socket = null;
  #generation = 0; // номер сокета: запізнілі події старого сокета ігноруємо
  #handlers = new Map();
  #queue = [];
  #attempt = 0;
  #timer = null;
  #state = 'idle';
  #wantOpen = false;

  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    handshake = () => null,
    backoff = {},
    maxQueue = 50,
    fatalCodes = DEFAULT_FATAL_CODES,
    timers = {
      setTimeout: (...a) => globalThis.setTimeout(...a),
      clearTimeout: (t) => globalThis.clearTimeout(t),
    },
  }) {
    super();
    this.#url = url;
    this.#WebSocket = WebSocketImpl;
    this.#handshake = handshake;
    this.#backoff = backoff;
    this.#maxQueue = maxQueue;
    this.#shouldReconnect = (code) => !fatalCodes.has(code);
    this.#timers = timers;
  }

  /** 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' */
  get state() {
    return this.#state;
  }

  get queued() {
    return this.#queue.length;
  }

  #setState(state) {
    if (this.#state === state) return;
    this.#state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state } }));
  }

  /** Підписка на повідомлення сервера за type. Повертає функцію відписки. */
  on(type, handler, { signal } = {}) {
    const set = this.#handlers.get(type) ?? new Set();
    this.#handlers.set(type, set);
    set.add(handler);

    const off = () => set.delete(handler);
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  connect() {
    if (this.#state === 'open' || this.#state === 'connecting') return;
    this.#wantOpen = true;
    this.#attempt = 0;
    this.#open();
  }

  #open() {
    this.#timers.clearTimeout(this.#timer);
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    const generation = ++this.#generation;
    let socket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch (error) {
      // напр. SyntaxError на кривому URL: перепідключення не допоможе
      this.#wantOpen = false;
      this.#setState('closed');
      this.dispatchEvent(
        new CustomEvent('fatal', {
          detail: { code: 0, reason: error.message },
        }),
      );
      return;
    }
    this.#socket = socket;

    // addEventListener, а не socket.onopen = this.#onOpen: так не втрачається this
    socket.addEventListener(
      'open',
      () => generation === this.#generation && this.#onOpen(),
    );
    socket.addEventListener(
      'message',
      (event) => generation === this.#generation && this.#onMessage(event.data),
    );
    socket.addEventListener(
      'close',
      (event) => generation === this.#generation && this.#onClose(event),
    );
    // 'error' у браузері не несе деталей, а за ним завжди йде 'close' — реагуємо там
    socket.addEventListener('error', () => {});
  }

  #onOpen() {
    this.#attempt = 0;
    this.#setState('open');

    // handshake — першим, ще до черги: сервер чекає join раніше за все інше
    const hello = this.#handshake();
    if (hello) this.#socket.send(JSON.stringify(hello));

    const queued = this.#queue.splice(0);
    for (const message of queued) this.#socket.send(JSON.stringify(message));

    this.dispatchEvent(new CustomEvent('open'));
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.dispatchEvent(
        new CustomEvent('protocolerror', {
          detail: { raw: String(raw).slice(0, 100) },
        }),
      );
      return;
    }
    if (!message || typeof message.type !== 'string') {
      this.dispatchEvent(
        new CustomEvent('protocolerror', {
          detail: { raw: String(raw).slice(0, 100) },
        }),
      );
      return;
    }

    for (const handler of [...(this.#handlers.get(message.type) ?? [])]) {
      try {
        handler(message);
      } catch (error) {
        // збій одного споживача не повинен глушити решту
        console.error(`[connection] handler "${message.type}":`, error);
      }
    }
  }

  #onClose({ code, reason }) {
    this.#socket = null;
    this.dispatchEvent(new CustomEvent('close', { detail: { code, reason } }));

    if (!this.#wantOpen) return this.#setState('closed');

    if (!this.#shouldReconnect(code)) {
      this.#wantOpen = false;
      this.#queue.length = 0;
      this.#setState('closed');
      this.dispatchEvent(
        new CustomEvent('fatal', { detail: { code, reason } }),
      );
      return;
    }

    this.#attempt += 1;
    const delayMs = backoffDelay(this.#attempt, this.#backoff);
    this.#setState('reconnecting');
    this.dispatchEvent(
      new CustomEvent('reconnecting', {
        detail: { attempt: this.#attempt, delayMs, code },
      }),
    );
    this.#timer = this.#timers.setTimeout(() => this.#open(), delayMs);
  }

  /**
   * @returns {'sent' | 'queued' | 'dropped'}
   * Не з'єднано — кладемо в чергу (не більше maxQueue; понад ліміт — відкидаємо,
   * інакше довга відсутність мережі з'їла б пам'ять).
   */
  send(message) {
    if (this.#state === 'open' && this.#socket?.readyState === OPEN) {
      this.#socket.send(JSON.stringify(message));
      return 'sent';
    }
    if (!this.#wantOpen && this.#state !== 'idle') return 'dropped'; // закрито остаточно
    if (this.#queue.length >= this.#maxQueue) return 'dropped';
    this.#queue.push(message);
    return 'queued';
  }

  /** Закрити остаточно: без перепідключення, чергу скинуто. */
  close(code = 1000, reason = 'bye') {
    this.#wantOpen = false;
    this.#timers.clearTimeout(this.#timer);
    this.#queue.length = 0;

    const socket = this.#socket;
    this.#socket = null;
    this.#generation += 1; // події цього сокета більше не цікавлять
    if (socket) {
      try {
        socket.close(code, reason);
      } catch {
        // уже закритий
      }
    }
    this.#setState('closed');
  }
}
