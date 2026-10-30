import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { createNdjsonTransform, startMatchLog } from '../src/log/matchlog.ts';
import type { MatchLog } from '../src/log/matchlog.ts';
import { ReplayError, listReplays, replay, replayPath } from '../src/log/replay.ts';
import { Room } from '../src/rooms.ts';
import { at, connect, fakePlayer, silent, sleep, startApp, tempDir } from './helpers.ts';

// Лог матчу — довільні JSON-об'єкти; у тесті читаємо їх як any (дані вже перевірені).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogRow = any;

async function collect(iterable: AsyncIterable<unknown>): Promise<LogRow[]> {
  const items: LogRow[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test("Transform: об'єкт → рядок NDJSON, по одному на подію", async () => {
  const chunks: string[] = [];
  await pipeline(
    Readable.from(
      [
        { t: 1, type: 'a' },
        { t: 2, type: 'б', text: 'привіт\nсвіт' },
      ],
      { objectMode: true },
    ),
    createNdjsonTransform(),
    async function (source: AsyncIterable<unknown>): Promise<void> {
      for await (const chunk of source) chunks.push(String(chunk));
    },
  );
  assert.equal(
    chunks.join(''),
    '{"t":1,"type":"a"}\n{"t":2,"type":"б","text":"привіт\\nсвіт"}\n',
  );
});

test('Transform: подія, яку не можна серіалізувати, не валить потік', async () => {
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  const out: LogRow[] = [];
  await pipeline(
    Readable.from([circular, { ok: 1 }], { objectMode: true }),
    createNdjsonTransform(),
    async function (source: AsyncIterable<unknown>): Promise<void> {
      let text = '';
      for await (const chunk of source) text += String(chunk);
      for (const line of text.trim().split('\n')) out.push(JSON.parse(line));
    },
  );
  assert.equal(at(out, 0).type, 'log_error');
  assert.deepEqual(at(out, 1), { ok: 1 });
});

test('startMatchLog: події кімнати потрапляють у файл, stop() дописує хвіст', async () => {
  const dir = await tempDir();
  const room = new Room({ id: 'arena', name: 'Арена' });
  let log: MatchLog | undefined;
  room.on('open', () => (log = startMatchLog(room, { dir, logger: silent })));

  room.join(fakePlayer('a')); // 'open' → лог стартує синхронно, перед першим join-подією
  room.join(fakePlayer('b'));
  room.chat('a', 'gl hf');
  room.leave('b');
  room.leave('a');
  assert(log);
  await log.stop();

  const events = await collect(replay(log.path));
  assert.deepEqual(
    events.map((e) => e.type),
    ['match_start', 'join', 'join', 'chat', 'leave', 'leave', 'match_end'],
  );
  assert.equal(at(events, 0).room.name, 'Арена');
  assert.equal(at(events, 3).text, 'gl hf');
  assert.ok(events.every((e) => typeof e.t === 'number'));

  const raw = await readFile(log.path, 'utf8');
  assert.equal(raw.split('\n').length, 8, '7 рядків + порожній після останнього \\n');
});

test('інтеграція: гравці у WebSocket → файл логу → список /api/replays → потік /api/replays/:id', async () => {
  const t = await startApp();
  try {
    const a = connect(t.wsUrl);
    await a.join('belt', 'Alice');
    a.send({ type: 'chat', text: 'лог?' });
    await a.waitForType('chat');
    a.send({ type: 'leave' });
    await a.closed;
    await sleep(100); // 'empty' → stop() → pipeline дописав файл

    const list: LogRow = await (await fetch(`${t.url}/api/replays`)).json();
    assert.equal(list.length, 1);
    assert.match(list[0].id, /^belt-\d{4}-\d{2}-\d{2}T/);

    const response = await fetch(`${t.url}/api/replays/${list[0].id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
    assert.equal(Number(response.headers.get('content-length')), list[0].bytes);
    const lines = (await response.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((e: LogRow) => e.type),
      ['match_start', 'join', 'chat', 'leave', 'match_end'],
    );
  } finally {
    await t.close();
  }
});

test('/api/replays/:id: некоректний id → 400, відсутній → 404', async () => {
  const t = await startApp();
  try {
    for (const id of ['..%2f..%2fetc%2fpasswd', 'a.b', 'x'.repeat(200)]) {
      const response = await fetch(`${t.url}/api/replays/${id}`);
      assert.equal(response.status, 400, id);
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${t.url}/api/replays/nope`)).status, 404);
    assert.equal(replayPath('/logs', '../x'), null);
    assert.equal(replayPath('/logs', 'ok-1'), join('/logs', 'ok-1.ndjson'));
  } finally {
    await t.close();
  }
});

test('replay: рядки довші за шматок читання (64 КБ) і багатобайтові символи не ламаються', async () => {
  const dir = await tempDir();
  const path = join(dir, 'big.ndjson');
  const events = Array.from({ length: 5 }, (_, i) => ({
    t: i,
    type: 'chat',
    text: 'їжак😀'.repeat(15_000 + i),
  }));
  await writeFile(path, events.map((e) => `${JSON.stringify(e)}\n`).join(''));

  const read = await collect(replay(path));
  assert.deepEqual(read, events);
});

test('replay: обрізаний хвіст ігнорується, биті рядки в середині — ні', async () => {
  const dir = await tempDir();
  const truncated = join(dir, 'truncated.ndjson');
  await writeFile(truncated, '{"t":1,"type":"a"}\n{"t":2,"type":"b"}\n{"t":3,"ty');
  assert.deepEqual(
    (await collect(replay(truncated))).map((e) => e.t),
    [1, 2],
  );

  const noNewline = join(dir, 'no-newline.ndjson');
  await writeFile(noNewline, '{"t":1,"type":"a"}\n{"t":2,"type":"b"}');
  assert.equal((await collect(replay(noNewline))).length, 2, 'валідний останній рядок без \\n зберігається');

  const corrupt = join(dir, 'corrupt.ndjson');
  await writeFile(corrupt, '{"t":1}\nNOT JSON\n{"t":3}\n');
  await assert.rejects(collect(replay(corrupt)), (e: unknown) => e instanceof ReplayError && e.line === 2);
});

test('listReplays: порожній/відсутній каталог → []', async () => {
  assert.deepEqual(await listReplays('/definitely/not/here'), []);
  assert.deepEqual(await listReplays(await tempDir()), []);
});

test('graceful shutdown: SIGTERM → код 0, сокети закриті 1001, лог дописаний', async () => {
  const root = await tempDir();
  const logDir = join(root, 'logs');
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/index.ts')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', LOG_DIR: logDir, STATIC_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c));
  child.stderr?.on('data', (c: Buffer) => (output += c));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`сервер не стартував: ${output}`)), 5000);
    child.stdout?.on('data', () => {
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });

  const client = connect(`ws://127.0.0.1:${port}/ws`);
  await client.join('training', 'Stayer');
  client.send({ type: 'chat', text: 'перед вимкненням' });
  await client.waitForType('chat');

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  child.kill('SIGTERM');

  const { code: closeCode } = await client.closed;
  assert.equal(closeCode, 1001, 'клієнту сказали "going away"');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.match(output, /зупинено, логи дописано/);

  const [file] = await readdir(logDir);
  assert(file);
  const events = await collect(replay(join(logDir, file)));
  assert.equal(at(events, -1).type, 'match_end', 'лог закритий коректно, а не обірваний');
  assert.ok(events.some((e) => e.type === 'chat' && e.text === 'перед вимкненням'));
});

test('невалідний конфіг: процес не стартує, код виходу 2', async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/index.ts')], {
    env: { ...process.env, PORT: 'abc' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => (stderr += c));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 2);
  assert.match(stderr, /PORT має бути цілим числом/);
});
