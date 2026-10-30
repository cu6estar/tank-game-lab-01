import type { CodecName, EncodedFrame } from '@tank/shared/protocol/types.ts';
import type { ArenaKey } from '@tank/shared/sim/game.ts';

/**
 * Спільні типи сервера. Транспорт (сокет) схований за цими інтерфейсами, тож
 * кімнату й матч можна тестувати без мережі (підставивши фейкового гравця).
 */

export interface SendOptions {
  readonly critical?: boolean;
}

export type SendFn = (message: unknown, options?: SendOptions) => boolean;
export type SendFrameFn = (frame: EncodedFrame, options?: SendOptions) => boolean;

/** Гравець так, як його бачить кімната/матч: без знання про WebSocket. */
export interface Player {
  id: string;
  name: string;
  /** Слот (0..N) у кімнаті; призначає Room при join. */
  slot: number;
  codec?: CodecName;
  send: SendFn;
  /** Надіслати вже закодований кадр (знімок/pong); є лише в мережевого гравця. */
  sendFrame?: SendFrameFn;
}

/** Конфіг арени кімнати (підмножина ArenaConfig; приходить із лобі). */
export type RoomArena = Readonly<Partial<Record<ArenaKey, number>>>;

/** Рядок логу матчу (подія 'event' кімнати). */
export interface MatchLogEvent {
  readonly t: number;
  readonly type: string;
  readonly [extra: string]: unknown;
}

/** Мінімальний логер (console його задовольняє; тести підставляють мовчазний). */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Код помилки Node (ENOENT, EADDRINUSE…) з `unknown` у catch. `useUnknownInCatchVariables`
 * робить змінну catch типом unknown, тому доступ до `.code` — тільки через звуження.
 */
export function errnoCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Текст помилки з unknown (для логів). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
