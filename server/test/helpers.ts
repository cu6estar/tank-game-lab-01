import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { ClientOptions, RawData } from 'ws';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { createApp } from '../src/index.ts';
import type { App } from '../src/index.ts';
import type { Player, SendOptions } from '../src/types.ts';

export const silent = {
  info(): void {},
  warn(): void {},
  error(): void {},
};

export const tempDir = (prefix = 'lab6-'): Promise<string> => mkdtemp(join(tmpdir(), prefix));

export interface TestApp {
  app: App;
  config: Config;
  root: string;
  port: number;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
}

/** Піднімає застосунок на вільному порту з тимчасовими каталогами. */
export async function startApp(
  env: Record<string, string> = {},
  { files = {} }: { files?: Record<string, string> } = {},
): Promise<TestApp> {
  const root = await tempDir();
  const staticDir = join(root, 'dist');
  await mkdir(staticDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(staticDir, name, '..'), { recursive: true });
    await writeFile(join(staticDir, name), body);
  }

  const config = loadConfig({ PORT: '0', LOG_DIR: join(root, 'logs'), STATIC_DIR: staticDir, ...env }, { baseDir: root });
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

/**
 * Повідомлення сервера в тестах довільної форми (welcome.you.name, roster.players…).
 * Тут навмисно `any`: це тестовий клієнт, а не бойовий код — він лише зчитує JSON,
 * який уже перевірив сервер. У самому сервері/клієнті/shared `any` немає.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServerMessage = any;

export interface CloseInfo {
  code: number;
  reason: string;
}

export interface Client {
  socket: WebSocket;
  messages: ServerMessage[];
  frames: Uint8Array[];
  opened: Promise<unknown>;
  closed: Promise<CloseInfo>;
  readonly closeInfo: CloseInfo | null;
  send(message: unknown): void;
  waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  waitForType(type: string, timeoutMs?: number): Promise<ServerMessage>;
  join(room?: string, name?: string, codec?: string): Promise<ServerMessage>;
}

const toBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  return new Uint8Array(data);
};

const toText = (data: RawData): string => Buffer.from(toBytes(data)).toString('utf8');

interface Waiter {
  check(): void;
}

/** Обгортка клієнта: збирає повідомлення і дає чекати на конкретне. */
export function connect(url: string, options?: ClientOptions): Client {
  const socket = new WebSocket(url, options);
  const messages: ServerMessage[] = [];
  const frames: Uint8Array[] = [];
  const waiters: Waiter[] = [];
  let closeInfo: CloseInfo | null = null;

  const closed = new Promise<CloseInfo>((resolve) => {
    socket.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
      resolve(closeInfo);
    });
  });
  socket.on('error', () => {}); // помилки перевіряємо через close, а не через throw

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      frames.push(toBytes(data));
      for (const waiter of [...waiters]) waiter.check();
      return;
    }
    messages.push(JSON.parse(toText(data)));
    for (const waiter of [...waiters]) waiter.check();
  });

  const opened = new Promise<unknown>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  function waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 2000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`не дочекались повідомлення; були: ${JSON.stringify(messages)}`));
      }, timeoutMs);
      const waiter: Waiter = {
        check(): void {
          const found = messages.find(predicate);
          if (found === undefined) return;
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
    get closeInfo(): CloseInfo | null {
      return closeInfo;
    },
    send: (message: unknown) =>
      socket.send(typeof message === 'string' ? message : JSON.stringify(message)),
    waitFor,
    waitForType: (type: string, timeoutMs?: number) => waitFor((m) => m.type === type, timeoutMs),
    async join(room = 'training', name = 'Ivan', codec?: string): Promise<ServerMessage> {
      await opened;
      socket.send(JSON.stringify({ type: 'join', v: 2, room, name, codec }));
      return waitFor((m) => m.type === 'welcome');
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Непорожній елемент (під noUncheckedIndexedAccess). */
export function at<T>(arr: readonly T[], index: number): T {
  const value = arr.at(index);
  assert(value !== undefined, `немає елемента ${index}`);
  return value;
}

export interface Inbox {
  message: ServerMessage;
  options: SendOptions | undefined;
}

export interface FakePlayer extends Player {
  inbox: Inbox[];
}

/** Фейковий гравець для тестів кімнати/матчу: збирає розіслані повідомлення в inbox. */
export function fakePlayer(id: string, name = id): FakePlayer {
  const inbox: Inbox[] = [];
  return {
    id,
    name,
    slot: 0, // Room перепризначить при join
    inbox,
    send: (message, options) => {
      inbox.push({ message, options });
      return true;
    },
  };
}
