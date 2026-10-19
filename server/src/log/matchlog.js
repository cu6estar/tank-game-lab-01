import { on } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Лог матчу — це конвеєр з трьох ланок:
 *
 *   події кімнати ──► Transform (об'єкт → рядок NDJSON) ──► файл
 *   Readable.from(on(room,'event'))   pipeline(...)        createWriteStream
 *
 * pipeline сам стежить за backpressure (зупиняє джерело, коли диск не встигає),
 * закриває всі ланки при помилці й повертає проміс, який завершується, коли
 * дані дійшли до файлу — саме на нього чекає graceful shutdown.
 */

/** Об'єкти на вході (objectMode), по рядку JSON + '\n' на виході. */
export function createNdjsonTransform() {
  return new Transform({
    writableObjectMode: true, // приймаємо об'єкти подій, віддаємо текст
    transform(event, _encoding, callback) {
      let line;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch (error) {
        // циклічна структура тощо — подію пропускаємо, потік не валимо
        line = `${JSON.stringify({ t: Date.now(), type: 'log_error', message: error.message })}\n`;
      }
      callback(null, line);
    },
  });
}

export function logFileName(roomId, date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `${roomId}-${stamp}.ndjson`;
}

/**
 * Запускає лог для кімнати. Слухач 'event' ставиться СИНХРОННО (events.on),
 * тому жодна подія між викликом і першим читанням не загубиться: вони
 * накопичуються в черзі ітератора.
 */
export function startMatchLog(
  room,
  { dir, now = Date.now, logger = console } = {},
) {
  const abort = new AbortController();
  const fileName = logFileName(room.id, new Date(now()));
  const path = join(dir, fileName);
  const id = fileName.replace(/\.ndjson$/, '');

  const events = on(room, 'event', { signal: abort.signal });

  async function* source() {
    yield {
      t: now(),
      type: 'match_start',
      room: { id: room.id, name: room.name },
    };
    try {
      // events.on віддає масиви аргументів: [event]
      for await (const [event] of events) yield event;
    } catch (error) {
      // abort — штатний кінець матчу; події, що вже стояли в черзі, доставлені до нього
      if (error.name !== 'AbortError') throw error;
    }
    yield { t: now(), type: 'match_end' };
  }

  const done = (async () => {
    await mkdir(dir, { recursive: true });
    await pipeline(
      Readable.from(source(), { objectMode: true }),
      createNdjsonTransform(),
      createWriteStream(path, { flags: 'a' }),
    );
  })();

  // Без цього збій запису став би unhandledRejection і поклав би процес
  done.catch((error) =>
    logger.error(`[matchlog] ${fileName}: ${error.message}`),
  );

  return {
    id,
    path,
    done,
    /** Завершити матч: дописати хвіст і закрити файл. */
    stop() {
      abort.abort();
      return done.catch(() => {});
    },
  };
}

/**
 * Підключає логи до менеджера кімнат: матч починається, коли в кімнаті
 * з'являється перший гравець, і закінчується, коли вона спорожніла.
 */
export function attachMatchLogs(
  manager,
  { dir, logger = console, now = Date.now },
) {
  const active = new Map(); // roomId → log, поки матч іде
  const stopping = new Set(); // логи, що вже дописуються (кімната спорожніла, але файл ще не закрито)

  const stopLog = (log) => {
    const pending = log.stop();
    stopping.add(pending);
    pending.finally(() => stopping.delete(pending));
    return pending;
  };

  const watch = (room) => {
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
    get active() {
      return active;
    },
    /** Для graceful shutdown: дописати й закрити всі відкриті логи. */
    async closeAll() {
      // Важливо чекати і на логи, які вже зупиняються: спорожніння кімнат під час
      // shutdown (ws.close() виганяє гравців) запускає stop() раніше за цей виклик,
      // і без очікування процес завершився б до того, як pipeline допише хвіст.
      for (const log of active.values()) stopLog(log);
      active.clear();
      await Promise.all([...stopping]);
    },
  };
}
