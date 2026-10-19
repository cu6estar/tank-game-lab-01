import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequestHandler } from './api.js';
import { ConfigError, loadConfig } from './config.js';
import { attachMatchLogs } from './log/matchlog.js';
import { RoomManager, seedRooms } from './rooms.js';
import { attachWebSocketServer } from './ws.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Збирає застосунок, але не слухає порт: тести створюють його на порту 0
 * (ОС обере вільний) і можуть закривати між перевірками.
 */
export function createApp({ config, logger = console }) {
  const rooms = seedRooms(new RoomManager({ maxRooms: config.maxRooms }));
  const matchLogs = attachMatchLogs(rooms, { dir: config.logDir, logger });

  let ws = null;
  const handler = createRequestHandler({
    config,
    rooms,
    logger,
    stats: () => ({ connections: ws?.connections ?? 0, ...ws?.stats }),
  });

  const server = createServer((req, res) => {
    // handler сам ловить помилки; .catch — страховка від unhandledRejection,
    // який у Node 15+ завершує процес
    handler(req, res).catch((error) => {
      logger.error(`[http] необроблена помилка: ${error.stack ?? error}`);
      res.destroy();
    });
  });
  // Помилки на рівні з'єднання (напр. клієнт обірвав на півслові) не повинні валити процес
  server.on('clientError', (error, socket) => {
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  ws = attachWebSocketServer({ server, rooms, config, logger });

  let closing = null;

  return {
    server,
    rooms,
    ws,
    matchLogs,

    async start() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject); // EADDRINUSE тощо — відмова start(), а не crash
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      return server.address();
    },

    /**
     * Graceful shutdown. Порядок важливий:
     *  1. server.close()        — більше не приймаємо нові з'єднання;
     *  2. ws.close()            — клієнтам 1001 "going away", чекаємо їхнього підтвердження;
     *  3. matchLogs.closeAll()  — дописати й закрити файли логів (pipeline завершується сам);
     *  4. після grace-періоду   — рвемо HTTP-з'єднання, що ще тривають (довгі завантаження).
     */
    close() {
      closing ??= (async () => {
        const httpClosed = new Promise((resolveClose) =>
          server.close(resolveClose),
        );
        server.closeIdleConnections();

        const force = setTimeout(
          () => server.closeAllConnections(),
          config.shutdownGraceMs,
        );
        await ws.close();
        await matchLogs.closeAll();
        await httpClosed;
        clearTimeout(force);
      })();
      return closing;
    },
  };
}

async function main() {
  let config;
  try {
    config = loadConfig(process.env, { baseDir: SERVER_ROOT });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(2); // 2 — "помилка використання/конфігурації", відмінна від crash (1)
    }
    throw error;
  }

  const app = createApp({ config });
  let address;
  try {
    address = await app.start();
  } catch (error) {
    // Найчастіше EADDRINUSE: друга копія сервера або чужий процес на цьому порту
    console.error(
      `[server] не вдалося слухати ${config.host}:${config.port} — ${error.code ?? error.message}`,
    );
    process.exit(1);
  }
  console.info(
    `[server] http://${address.address}:${address.port}  (логи: ${config.logDir})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`[server] ${signal}: зупиняюсь…`);

    // Якщо щось завмерло — не висимо вічно
    setTimeout(
      () => {
        console.error('[server] shutdown завис, примусовий вихід');
        process.exit(1);
      },
      config.shutdownGraceMs * 2 + 2000,
    ).unref();

    await app.close();
    console.info('[server] зупинено, логи дописано');
    process.exit(0);
  };

  // once: повторний Ctrl+C діє як зазвичай (негайне завершення)
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
