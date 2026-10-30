import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Config } from './config.ts';
import { listReplays, replayPath } from './log/replay.ts';
import { RoomError, validateRoomInput } from './rooms.ts';
import type { RoomManager } from './rooms.ts';
import { serveStatic } from './static.ts';
import type { Logger } from './types.ts';
import { errnoCode, errorMessage } from './types.ts';

export const MAX_BODY_BYTES = 4096;

class HttpError extends Error {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  constructor(status: number, message: string, headers: OutgoingHttpHeaders = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
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
 * Читає тіло запиту з жорстким лімітом. req — Readable-потік: рахуємо байти по
 * мірі надходження і зупиняємось. Без ліміту нескінченне тіло з'їло б пам'ять.
 */
export async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, `Тіло завелике (ліміт ${limit} байт)`, { Connection: 'close' });
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) {
      throw new HttpError(413, `Тіло завелике (ліміт ${limit} байт)`, { Connection: 'close' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
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
function busyWait(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // крутимось: жодного await, тому жоден інший запит не обслуговується
  }
}

const allow = (methods: string[]): OutgoingHttpHeaders => ({ Allow: methods.join(', ') });

export type StatsFn = () => Record<string, unknown>;

export interface RequestHandlerOptions {
  readonly config: Config;
  readonly rooms: RoomManager;
  readonly logger?: Logger;
  readonly stats?: StatsFn;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Створює обробник HTTP-запитів. Маршрутизація — вручну за pathname:
 * для кількох маршрутів фреймворк не потрібен.
 */
export function createRequestHandler({ config, rooms, logger = console, stats = () => ({}) }: RequestHandlerOptions): RequestHandler {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    const { method } = req;

    if (pathname === '/health') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
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

    // Статистика матчів: tickMs і jitterMs показують, чи встигає сервер тримати 30 Гц.
    if (pathname === '/api/stats') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      return sendJson(res, 200, { uptimeSec: Math.round(process.uptime()), ...stats() });
    }

    if (pathname === '/api/rooms') {
      if (method === 'GET') return sendJson(res, 200, rooms.list());
      if (method === 'POST') {
        const input = validateRoomInput(await readJson(req), config);
        if (!input.ok) return sendJson(res, 422, { error: 'validation', details: input.errors });

        const room = rooms.create(input.value); // RoomError('limit') → 429 нижче
        return sendJson(res, 201, room.summary(), { Location: `/api/rooms/${room.id}` });
      }
      throw new HttpError(405, 'Method Not Allowed', allow(['GET', 'POST']));
    }

    if (pathname === '/api/replays') {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      return sendJson(res, 200, await listReplays(config.logDir));
    }

    if (pathname.startsWith('/api/replays/')) {
      if (method !== 'GET') throw new HttpError(405, 'Method Not Allowed', allow(['GET']));
      return streamReplay(res, decodeURIComponent(pathname.slice('/api/replays/'.length)));
    }

    if (pathname === '/api/slow' && config.demoEndpoints) {
      const started = performance.now();
      busyWait(300);
      return sendJson(res, 200, { blockedMs: Math.round(performance.now() - started) });
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Не знайдено');

    return serveStatic(req, res, { root: config.staticDir, logger });
  }

  /**
   * Повтор матчу віддаємо ПОТОКОМ: файл ніколи не читається в пам'ять цілком.
   * pipeline(readStream, res) сам призупиняє читання, коли сокет клієнта повний.
   */
  async function streamReplay(res: ServerResponse, id: string): Promise<void> {
    const path = replayPath(config.logDir, id);
    if (!path) throw new HttpError(400, 'Некоректний id повтору');

    let info;
    try {
      info = await stat(path);
    } catch (error: unknown) {
      if (errnoCode(error) === 'ENOENT') throw new HttpError(404, 'Повтор не знайдено');
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
    } catch (error: unknown) {
      // клієнт обірвав завантаження — це норма, а не помилка сервера
      if (errnoCode(error) !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.error(`[replay] ${id}: ${errorMessage(error)}`);
      }
      res.destroy();
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch (error: unknown) {
      if (res.headersSent) {
        logger.error(`[http] ${req.method} ${req.url}: ${errorMessage(error)}`);
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        return sendJson(res, error.status, { error: error.message }, error.headers);
      }
      if (error instanceof RoomError) {
        const status = error.code === 'limit' ? 429 : 409;
        return sendJson(res, status, { error: error.message });
      }
      // Подробиці — у лог, клієнту — нейтральне повідомлення (без стеку й шляхів)
      logger.error(`[http] ${req.method} ${req.url}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      sendJson(res, 500, { error: 'Внутрішня помилка сервера' });
    }
  };
}
