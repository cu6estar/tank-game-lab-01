import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from './api.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { attachMatchLogs } from './log/matchlog.ts';
import type { MatchLogs } from './log/matchlog.ts';
import { attachMatches } from './matches.ts';
import type { Matches } from './matches.ts';
import { RoomManager, seedRooms } from './rooms.ts';
import { attachWebSocketServer } from './ws.ts';
import type { WsServer } from './ws.ts';
import type { Logger } from './types.ts';
import { errnoCode, errorMessage } from './types.ts';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface App {
  readonly server: Server;
  readonly rooms: RoomManager;
  readonly ws: WsServer;
  readonly matchLogs: MatchLogs;
  readonly matches: Matches;
  start(): Promise<AddressInfo>;
  close(): Promise<void>;
}

/**
 * Збирає застосунок, але не слухає порт: тести створюють його на порту 0
 * (ОС обере вільний) і можуть закривати між перевірками.
 */
export function createApp({ config, logger = console }: { config: Config; logger?: Logger }): App {
  const rooms = seedRooms(new RoomManager({ maxRooms: config.maxRooms }));
  const matchLogs = attachMatchLogs(rooms, { dir: config.logDir, logger });
  const matches = attachMatches(rooms, { logger });

  let ws: WsServer | null = null;

  // Лаг циклу подій: якщо він великий — крок 30 Гц сервер уже не тримає.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let accepting = true; // стає false під час зупинки → /ready = 503
  let lastSample = { t: performance.now(), messages: 0, bytes: 0 };

  const ms = (ns: number): number => (Number.isFinite(ns) ? +(ns / 1e6).toFixed(3) : 0);

  const metrics = (): Record<string, unknown> => {
    const s = ws?.stats;
    const now = performance.now();
    const elapsedSec = Math.max(0.001, (now - lastSample.t) / 1000);
    const messages = s?.messages ?? 0;
    const bytes = s?.bytes ?? 0;
    const perSec = {
      messages: +((messages - lastSample.messages) / elapsedSec).toFixed(1),
      bytes: Math.round((bytes - lastSample.bytes) / elapsedSec),
    };
    lastSample = { t: now, messages, bytes };

    const matchStats = matches.stats();
    const players = matchStats.reduce((sum, m) => sum + m.players, 0);
    const tickMsMax = matchStats.reduce((max, m) => Math.max(max, m.tickMs.max), 0);
    const mem = process.memoryUsage();
    return {
      rooms: rooms.size,
      players,
      connections: ws?.connections ?? 0,
      messagesTotal: messages,
      bytesTotal: bytes,
      rejected: s?.rejected ?? 0,
      perSec,
      tickMsMax: +tickMsMax.toFixed(3),
      eventLoopLagMs: {
        // histogram ще без семплів → NaN; зводимо до 0, інакше JSON дасть null
        mean: ms(loopDelay.mean),
        p99: ms(loopDelay.percentile(99)),
        max: ms(loopDelay.max),
      },
      memoryMB: { rss: +(mem.rss / 1048576).toFixed(1), heapUsed: +(mem.heapUsed / 1048576).toFixed(1) },
    };
  };

  const handler = createRequestHandler({
    config,
    rooms,
    logger,
    ready: () => accepting,
    metrics,
    stats: () => ({
      connections: ws?.connections ?? 0,
      ...(ws ? ws.stats : {}),
      matches: matches.stats(),
    }),
  });

  const server = createServer((req, res) => {
    // handler сам ловить помилки; .catch — страховка від unhandledRejection
    handler(req, res).catch((error: unknown) => {
      logger.error(`[http] необроблена помилка: ${errorMessage(error)}`);
      res.destroy();
    });
  });
  // Помилки на рівні з'єднання не повинні валити процес
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const wsServer = attachWebSocketServer({ server, rooms, config, logger });
  ws = wsServer;

  let closing: Promise<void> | null = null;

  return {
    server,
    rooms,
    ws: wsServer,
    matchLogs,
    matches,

    async start(): Promise<AddressInfo> {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject); // EADDRINUSE тощо — відмова start(), а не crash
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('очікувалась TCP-адреса після listen');
      }
      return address;
    },

    /**
     * Graceful shutdown: 1) server.close (нові з'єднання не приймаємо);
     * 2) ws.close (клієнтам 1001); 3) matchLogs.closeAll (дописати логи);
     * 4) після grace — рвемо HTTP-з'єднання, що ще тривають.
     */
    close(): Promise<void> {
      closing ??= (async () => {
        accepting = false; // /ready → 503: балансувальник перестає слати нових
        loopDelay.disable();
        const httpClosed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        server.closeIdleConnections();

        const force = setTimeout(() => server.closeAllConnections(), config.shutdownGraceMs);
        await wsServer.close();
        matches.stopAll();
        await matchLogs.closeAll();
        await httpClosed;
        clearTimeout(force);
      })();
      return closing;
    },
  };
}

async function main(): Promise<void> {
  // Необроблений виняток/відмову ЛОГУЄМО і виходимо (код 1) — не глушимо порожнім
  // обробником: процес у невизначеному стані краще перезапустити, ніж лишити живим.
  process.on('uncaughtException', (error: unknown) => {
    console.error(`[server] uncaughtException: ${errorMessage(error)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(`[server] unhandledRejection: ${errorMessage(reason)}`);
    process.exit(1);
  });

  let config: Config;
  try {
    config = loadConfig(process.env, { baseDir: SERVER_ROOT });
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(2); // 2 — помилка конфігурації, відмінна від crash (1)
    }
    throw error;
  }

  const app = createApp({ config });
  let address: AddressInfo;
  try {
    address = await app.start();
  } catch (error: unknown) {
    console.error(`[server] не вдалося слухати ${config.host}:${config.port} — ${errnoCode(error) ?? errorMessage(error)}`);
    process.exit(1);
  }
  console.info(`[server] http://${address.address}:${address.port}  sha=${config.gitSha}  (логи: ${config.logDir})`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[server] ${signal}: зупиняюсь…`);

    setTimeout(() => {
      console.error('[server] shutdown завис, примусовий вихід');
      process.exit(1);
    }, config.shutdownGraceMs * 2 + 2000).unref();

    await app.close();
    console.info('[server] зупинено, логи дописано');
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
