import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { listReplays, replayPath } from './log/replay.js';
import { RoomError, validateRoomInput } from './rooms.js';
import { serveStatic } from './static.js';

export const MAX_BODY_BYTES = 4096;

class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * Читає тіло запиту з жорстким лімітом. req — це Readable-потік: ми рахуємо
 * байти по мірі надходження і зупиняємось, не чекаючи кінця. Без ліміту клієнт,
 * що шле нескінченне тіло, повільно з'їв би всю пам'ять сервера.
 */
export async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `Тіло завелике (ліміт ${limit} байт)`, {
      Connection: 'close',
    });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, `Тіло завелике (ліміт ${limit} байт)`, {
        Connection: 'close',
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readJson(req) {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Потрібен Content-Type: application/json');
  }
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Тіло не є коректним JSON');
  }
}

/** Навмисне блокування циклу подій — лише для демонстрації в README (DEMO_ENDPOINTS=1). */
function busyWait(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // крутимось: жодного await, тому жоден інший запит не обслуговується
  }
}

const allow = (methods) => ({ Allow: methods.join(', ') });

/**
 * Створює обробник HTTP-запитів. Маршрутизація — вручну за pathname:
 * для чотирьох маршрутів фреймворк не потрібен (stretch: порт на Fastify).
 */
export function createRequestHandler({
  config,
  rooms,
  logger = console,
  stats = () => ({}),
}) {
  async function route(req, res) {
    const pathname = (req.url ?? '/').split('?')[0];
    const { method } = req;

    if (pathname === '/health') {
      if (method !== 'GET')
        throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      const { rss, heapUsed } = process.memoryUsage();
      return sendJson(res, 200, {
        status: 'ok',
        uptimeSec: Math.round(process.uptime()),
        rss,
        heapUsed,
        rooms: rooms.size,
        ...stats(),
      });
    }

    // Статистика матчів: тривалість кроку (tickMs) і jitter таймера (jitterMs) — те, за
    // чим видно, що сервер не встигає тримати 30 Гц. Деталі — у README, розділ "Сервер рахує гру".
    if (pathname === '/api/stats') {
      if (method !== 'GET')
        throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      return sendJson(res, 200, {
        uptimeSec: Math.round(process.uptime()),
        ...stats(),
      });
    }

    if (pathname === '/api/rooms') {
      if (method === 'GET') return sendJson(res, 200, rooms.list());
      if (method === 'POST') {
        const input = validateRoomInput(await readJson(req), config);
        if (!input.ok)
          return sendJson(res, 422, {
            error: 'validation',
            details: input.errors,
          });

        const room = rooms.create(input.value); // RoomError('limit') → 429 нижче
        return sendJson(res, 201, room.summary(), {
          Location: `/api/rooms/${room.id}`,
        });
      }
      throw new HttpError(405, 'Method Not Allowed', allow(['GET', 'POST']));
    }

    if (pathname === '/api/replays') {
      if (method !== 'GET')
        throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      return sendJson(res, 200, await listReplays(config.logDir));
    }

    if (pathname.startsWith('/api/replays/')) {
      if (method !== 'GET')
        throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      return streamReplay(
        res,
        decodeURIComponent(pathname.slice('/api/replays/'.length)),
      );
    }

    if (pathname === '/api/slow' && config.demoEndpoints) {
      const started = performance.now();
      busyWait(300);
      return sendJson(res, 200, {
        blockedMs: Math.round(performance.now() - started),
      });
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Не знайдено');

    return serveStatic(req, res, { root: config.staticDir, logger });
  }

  /**
   * Повтор матчу віддаємо ПОТОКОМ: файл ніколи не читається в пам'ять цілком.
   * pipeline(readStream, res) сам призупиняє читання, коли сокет клієнта повний
   * (res.write() повернув false), і чекає 'drain' — це і є backpressure.
   */
  async function streamReplay(res, id) {
    const path = replayPath(config.logDir, id);
    if (!path) throw new HttpError(400, 'Некоректний id повтору');

    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new HttpError(404, 'Повтор не знайдено');
      throw error;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${id}.ndjson"`,
      'X-Content-Type-Options': 'nosniff',
    });

    try {
      await pipeline(createReadStream(path), res);
    } catch (error) {
      // клієнт обірвав завантаження — це норма, а не помилка сервера
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.error(`[replay] ${id}: ${error.message}`);
      }
      res.destroy();
    }
  }

  return async function handle(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) {
        logger.error(`[http] ${req.method} ${req.url}: ${error.message}`);
        return res.destroy();
      }
      if (error instanceof HttpError) {
        return sendJson(
          res,
          error.status,
          { error: error.message },
          error.headers,
        );
      }
      if (error instanceof RoomError) {
        const status = error.code === 'limit' ? 429 : 409;
        return sendJson(res, status, { error: error.message });
      }
      // Подробиці — у лог, клієнту — нейтральне повідомлення (без стеку й шляхів)
      logger.error(`[http] ${req.method} ${req.url}: ${error.stack ?? error}`);
      sendJson(res, 500, { error: 'Внутрішня помилка сервера' });
    }
  };
}
