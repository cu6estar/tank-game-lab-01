import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/index.js';

export const silent = { info() {}, warn() {}, error() {} };

export const tempDir = (prefix = 'lab4-') => mkdtemp(join(tmpdir(), prefix));

/** Піднімає застосунок на вільному порту з тимчасовими каталогами. */
export async function startApp(env = {}, { files = {} } = {}) {
  const root = await tempDir();
  const staticDir = join(root, 'dist');
  await mkdir(staticDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(staticDir, name, '..'), { recursive: true });
    await writeFile(join(staticDir, name), body);
  }

  const config = loadConfig(
    {
      PORT: '0',
      LOG_DIR: join(root, 'logs'),
      STATIC_DIR: staticDir,
      ...env,
    },
    { baseDir: root },
  );
  const app = createApp({ config, logger: silent });
  const { port } = await app.start();

  return {
    app,
    config,
    root,
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    close: () => app.close(),
  };
}

/** Обгортка клієнта: збирає повідомлення і дає чекати на конкретне. */
export function connect(url, options) {
  const socket = new WebSocket(url, options);
  const messages = [];
  const frames = []; // бінарні кадри (знімки, pong) у порядку надходження
  const waiters = [];
  let closeInfo = null;

  const closed = new Promise((resolve) => {
    socket.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
      resolve(closeInfo);
    });
  });
  socket.on('error', () => {}); // помилки перевіряємо через close, а не через throw

  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      frames.push(new Uint8Array(data));
      for (const waiter of [...waiters]) waiter.check();
      return;
    }
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...waiters]) waiter.check();
  });

  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  function waitFor(predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `не дочекались повідомлення; були: ${JSON.stringify(messages)}`,
          ),
        );
      }, timeoutMs);
      const waiter = {
        check() {
          const found = messages.find(predicate);
          if (!found) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve(found);
        },
      };
      waiters.push(waiter);
      waiter.check();
    });
  }

  return {
    socket,
    messages,
    frames,
    opened,
    closed,
    get closeInfo() {
      return closeInfo;
    },
    send: (message) =>
      socket.send(
        typeof message === 'string' ? message : JSON.stringify(message),
      ),
    waitFor,
    waitForType: (type, timeoutMs) =>
      waitFor((m) => m.type === type, timeoutMs),
    async join(room = 'training', name = 'Ivan', codec) {
      await opened;
      socket.send(JSON.stringify({ type: 'join', v: 2, room, name, codec }));
      return waitFor((m) => m.type === 'welcome');
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
