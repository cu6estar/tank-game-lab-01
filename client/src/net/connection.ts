import type { EncodedFrame } from '@tank/shared/protocol/types.ts';
import type { LagInjector, LagChannel } from './lag.ts';
import type { IncomingMessage } from './messages.ts';

/**
 * Обгортка над WebSocket: диспетчер за `type`, черга send() і перепідключення.
 * Життєвий цикл повідомляється подіями (EventTarget): 'open', 'close',
 * 'reconnecting', 'fatal', 'statechange', 'protocolerror'.
 */

/** JSON-повідомлення "гри" (а не чату/кімнат): саме їх затримує інжектор лагу. */
export const GAME_TYPES = new Set(['snapshot', 'pong', 'input', 'ping']);

const OPEN = 1; // WebSocket.OPEN: не залежимо від глобальної змінної (тестам підставляється фейк)

/** Коди, після яких повторювати марно: сервер сказав "ні" свідомо. */
export const DEFAULT_FATAL_CODES = new Set([1003, 1009, 4001, 4002, 4003, 4004, 4006]);

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Мінімальний контракт сокета (браузерний WebSocket його задовольняє; тест підставляє фейк). */
export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: EncodedFrame): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
}

export type SocketCtor = new (url: string) => SocketLike;

export interface BackoffOptions {
  readonly baseMs?: number;
  readonly maxMs?: number;
  readonly random?: () => number;
}

export interface ConnectionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ConnectionOptions {
  readonly url: string;
  readonly WebSocketImpl?: SocketCtor;
  readonly handshake?: () => unknown;
  readonly backoff?: BackoffOptions;
  readonly maxQueue?: number;
  readonly fatalCodes?: Set<number>;
  readonly lag?: LagInjector | null;
  readonly onBinary?: ((frame: Uint8Array) => void) | null;
  readonly timers?: ConnectionTimers;
}

export type MessageHandler<T extends IncomingMessage = IncomingMessage> = (message: T, size: number) => void;

export interface ConnectionEventMap {
  open: CustomEvent<undefined>;
  close: CustomEvent<{ code: number; reason: string }>;
  reconnecting: CustomEvent<{ attempt: number; delayMs: number; code: number }>;
  fatal: CustomEvent<{ code: number; reason: string }>;
  statechange: CustomEvent<{ state: ConnectionState }>;
  protocolerror: CustomEvent<{ raw: string }>;
}

/**
 * Пауза перед спробою №attempt (з 1): стеля росте як base·2^(n−1) до maxMs,
 * а реальна пауза — випадкова в [стеля/2, стеля] ("equal jitter").
 */
export function backoffDelay(attempt: number, { baseMs = 500, maxMs = 15_000, random = Math.random }: BackoffOptions = {}): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

const defaultTimers: ConnectionTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// Типізовані перевантаження подій життєвого циклу (злиття оголошень).
export interface Connection {
  addEventListener<K extends keyof ConnectionEventMap>(
    type: K,
    listener: (event: ConnectionEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void;
}

export class Connection extends EventTarget {
  #url: string;
  #WebSocket: SocketCtor;
  #handshake: () => unknown;
  #backoff: BackoffOptions;
  #maxQueue: number;
  #shouldReconnect: (code: number) => boolean;
  #timers: ConnectionTimers;
  #lag: LagInjector | null;
  #onBinary: ((frame: Uint8Array) => void) | null;
  #socket: SocketLike | null = null;
  #generation = 0; // номер сокета: запізнілі події старого сокета ігноруємо
  #handlers = new Map<string, Set<MessageHandler>>();
  #queue: unknown[] = [];
  #attempt = 0;
  #timer: unknown = null;
  #state: ConnectionState = 'idle';
  #wantOpen = false;

  constructor({
    url,
    WebSocketImpl,
    handshake = () => null,
    backoff = {},
    maxQueue = 50,
    fatalCodes = DEFAULT_FATAL_CODES,
    lag = null,
    onBinary = null,
    timers = defaultTimers,
  }: ConnectionOptions) {
    super();
    this.#url = url;
    this.#WebSocket = WebSocketImpl ?? (globalThis.WebSocket as unknown as SocketCtor);
    this.#handshake = handshake;
    this.#backoff = backoff;
    this.#maxQueue = maxQueue;
    this.#shouldReconnect = (code) => !fatalCodes.has(code);
    this.#timers = timers;
    this.#lag = lag;
    this.#onBinary = onBinary;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get queued(): number {
    return this.#queue.length;
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state } }));
  }

  /** Підписка на повідомлення сервера за type. Повертає функцію відписки. */
  on<T extends IncomingMessage = IncomingMessage>(type: string, handler: MessageHandler<T>, { signal }: { signal?: AbortSignal } = {}): () => void {
    const set = this.#handlers.get(type) ?? new Set<MessageHandler>();
    this.#handlers.set(type, set);
    // T — звуження IncomingMessage за полем type; зберігаємо під базовим типом
    const stored = handler as MessageHandler;
    set.add(stored);

    const off = (): void => void set.delete(stored);
    signal?.addEventListener('abort', off, { once: true });
    return off;
  }

  connect(): void {
    if (this.#state === 'open' || this.#state === 'connecting') return;
    this.#wantOpen = true;
    this.#attempt = 0;
    this.#open();
  }

  #open(): void {
    this.#timers.clearTimeout(this.#timer);
    this.#setState(this.#attempt === 0 ? 'connecting' : 'reconnecting');

    const generation = ++this.#generation;
    let socket: SocketLike;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch (error: unknown) {
      // напр. SyntaxError на кривому URL: перепідключення не допоможе
      this.#wantOpen = false;
      this.#setState('closed');
      this.dispatchEvent(new CustomEvent('fatal', { detail: { code: 0, reason: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    this.#socket = socket;
    socket.binaryType = 'arraybuffer'; // бінарні кадри як ArrayBuffer, не Blob

    socket.addEventListener('open', () => generation === this.#generation && this.#onOpen());
    socket.addEventListener('message', (event) => {
      if (generation === this.#generation) this.#onMessage(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (generation === this.#generation) this.#onClose(event);
    });
    // 'error' у браузері не несе деталей, а за ним завжди йде 'close' — реагуємо там
    socket.addEventListener('error', () => {});
  }

  #onOpen(): void {
    this.#attempt = 0;
    this.#setState('open');

    // handshake — першим, ще до черги: сервер чекає join раніше за все інше
    const hello = this.#handshake();
    if (hello) this.#socket?.send(JSON.stringify(hello));

    const queued = this.#queue.splice(0);
    for (const message of queued) this.#socket?.send(JSON.stringify(message));

    this.dispatchEvent(new CustomEvent('open'));
  }

  #onMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      // бінарний кадр = гра (знімок, pong): шлях приймання теж проходить через інжектор
      const frame = new Uint8Array(raw as ArrayBuffer);
      this.#viaLag(() => this.#onBinary?.(frame), 'in');
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      this.dispatchEvent(new CustomEvent('protocolerror', { detail: { raw: raw.slice(0, 100) } }));
      return;
    }
    if (typeof message !== 'object' || message === null || typeof (message as IncomingMessage).type !== 'string') {
      this.dispatchEvent(new CustomEvent('protocolerror', { detail: { raw: raw.slice(0, 100) } }));
      return;
    }
    const typed = message as IncomingMessage;

    const dispatch = (): void => {
      for (const handler of [...(this.#handlers.get(typed.type) ?? [])]) {
        try {
          handler(typed, raw.length);
        } catch (error: unknown) {
          console.error(`[connection] handler "${typed.type}":`, error);
        }
      }
    };
    if (GAME_TYPES.has(typed.type)) this.#viaLag(dispatch, 'in');
    else dispatch();
  }

  #viaLag(fn: () => void, channel: LagChannel = 'out'): void {
    if (this.#lag) this.#lag.pass(fn, channel);
    else fn();
  }

  #onClose({ code, reason }: { code: number; reason: string }): void {
    this.#socket = null;
    this.dispatchEvent(new CustomEvent('close', { detail: { code, reason } }));

    if (!this.#wantOpen) return this.#setState('closed');

    if (!this.#shouldReconnect(code)) {
      this.#wantOpen = false;
      this.#queue.length = 0;
      this.#setState('closed');
      this.dispatchEvent(new CustomEvent('fatal', { detail: { code, reason } }));
      return;
    }

    this.#attempt += 1;
    const delayMs = backoffDelay(this.#attempt, this.#backoff);
    this.#setState('reconnecting');
    this.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: this.#attempt, delayMs, code } }));
    this.#timer = this.#timers.setTimeout(() => this.#open(), delayMs);
  }

  /** @returns 'sent' | 'queued' | 'dropped' */
  send(message: unknown): 'sent' | 'queued' | 'dropped' {
    if (this.#state === 'open' && this.#socket?.readyState === OPEN) {
      this.#socket.send(JSON.stringify(message));
      return 'sent';
    }
    if (!this.#wantOpen && this.#state !== 'idle') return 'dropped'; // закрито остаточно
    if (this.#queue.length >= this.#maxQueue) return 'dropped';
    this.#queue.push(message);
    return 'queued';
  }

  /**
   * Ігровий трафік (ввід, ping): не буферизується й не повторюється. Проходить
   * через інжектор лагу. `frame` — рядок (JSON) або Uint8Array (бінарний).
   * @returns false, якщо сокет не відкритий
   */
  sendGame(frame: EncodedFrame): boolean {
    const socket = this.#socket;
    if (this.#state !== 'open' || socket?.readyState !== OPEN) return false;
    this.#viaLag(() => {
      // за час затримки сокет міг закритись/замінитись
      if (socket === this.#socket && socket.readyState === OPEN) socket.send(frame);
    });
    return true;
  }

  /** Закрити остаточно: без перепідключення, чергу скинуто. */
  close(code = 1000, reason = 'bye'): void {
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
