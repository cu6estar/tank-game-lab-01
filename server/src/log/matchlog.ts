import { on } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Room, RoomManager } from '../rooms.ts';
import type { Logger, MatchLogEvent } from '../types.ts';
import { errorMessage } from '../types.ts';

/**
 * Лог матчу — це конвеєр з трьох ланок:
 *
 *   події кімнати ──► Transform (об'єкт → рядок NDJSON) ──► файл
 *
 * pipeline сам стежить за backpressure (зупиняє джерело, коли диск не встигає),
 * закриває всі ланки при помилці й повертає проміс, який завершується, коли
 * дані дійшли до файлу — саме на нього чекає graceful shutdown.
 */

/** Об'єкти на вході (objectMode), по рядку JSON + '\n' на виході. */
export function createNdjsonTransform(): Transform {
  return new Transform({
    writableObjectMode: true, // приймаємо об'єкти подій, віддаємо текст
    transform(event: unknown, _encoding, callback): void {
      let line: string;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch (error: unknown) {
        // циклічна структура тощо — подію пропускаємо, потік не валимо
        line = `${JSON.stringify({ t: Date.now(), type: 'log_error', message: errorMessage(error) })}\n`;
      }
      callback(null, line);
    },
  });
}

export function logFileName(roomId: string, date: Date = new Date()): string {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `${roomId}-${stamp}.ndjson`;
}

export interface MatchLog {
  readonly id: string;
  readonly path: string;
  readonly done: Promise<void>;
  /** Завершити матч: дописати хвіст і закрити файл. */
  stop(): Promise<void>;
}

export interface MatchLogOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * Запускає лог для кімнати. Слухач 'event' ставиться СИНХРОННО (events.on),
 * тому жодна подія між викликом і першим читанням не загубиться.
 */
export function startMatchLog(room: Room, { dir, now = Date.now, logger = console }: MatchLogOptions): MatchLog {
  const abort = new AbortController();
  const fileName = logFileName(room.id, new Date(now()));
  const path = join(dir, fileName);
  const id = fileName.replace(/\.ndjson$/, '');

  const events = on(room, 'event', { signal: abort.signal });

  async function* source(): AsyncGenerator<MatchLogEvent, void, undefined> {
    yield { t: now(), type: 'match_start', room: { id: room.id, name: room.name } };
    try {
      // events.on віддає масиви аргументів: [event]
      for await (const [event] of events) yield event as MatchLogEvent;
    } catch (error: unknown) {
      // abort — штатний кінець матчу; події, що вже стояли в черзі, доставлені до нього
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    }
    yield { t: now(), type: 'match_end' };
  }

  const done: Promise<void> = (async () => {
    await mkdir(dir, { recursive: true });
    await pipeline(
      Readable.from(source(), { objectMode: true }),
      createNdjsonTransform(),
      createWriteStream(path, { flags: 'a' }),
    );
  })();

  // Без цього збій запису став би unhandledRejection і поклав би процес
  done.catch((error: unknown) => logger.error(`[matchlog] ${fileName}: ${errorMessage(error)}`));

  return {
    id,
    path,
    done,
    stop(): Promise<void> {
      abort.abort();
      return done.catch(() => {});
    },
  };
}

export interface MatchLogs {
  readonly active: ReadonlyMap<string, MatchLog>;
  closeAll(): Promise<void>;
}

/**
 * Підключає логи до менеджера кімнат: матч починається, коли в кімнаті
 * з'являється перший гравець, і закінчується, коли вона спорожніла.
 */
export function attachMatchLogs(
  manager: RoomManager,
  { dir, logger = console, now = Date.now }: { dir: string; logger?: Logger; now?: () => number },
): MatchLogs {
  const active = new Map<string, MatchLog>();
  const stopping = new Set<Promise<void>>();

  const stopLog = (log: MatchLog): Promise<void> => {
    const pending = log.stop();
    stopping.add(pending);
    void pending.finally(() => stopping.delete(pending));
    return pending;
  };

  const watch = (room: Room): void => {
    room.on('open', () => {
      active.set(room.id, startMatchLog(room, { dir, logger, now }));
    });
    room.on('empty', () => {
      const log = active.get(room.id);
      active.delete(room.id);
      if (log) stopLog(log);
    });
  };

  manager.on('created', watch);
  for (const room of manager) watch(room);

  return {
    get active(): ReadonlyMap<string, MatchLog> {
      return active;
    },
    async closeAll(): Promise<void> {
      for (const log of active.values()) stopLog(log);
      active.clear();
      await Promise.all([...stopping]);
    },
  };
}
