import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveStaticPath } from '../src/static.ts';
import { startApp } from './helpers.ts';
import type { TestApp } from './helpers.ts';

// Відповіді API в тестах читаємо вільно (сервер їх уже сформував зі своїх типів).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const readJson = (response: Response): Promise<Json> => response.json();

interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

const json = (body: unknown, headers: Record<string, string> = {}): FetchInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** fetch нормалізує "/../" ще на клієнті, тож атаки шлемо сирим TCP. */
function rawRequest(port: number, path: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => (data += chunk));
    socket.on('end', () => resolve({ status: Number(data.split(' ')[1]), data }));
    socket.on('error', reject);
  });
}

describe('HTTP API і статика', () => {
  let t: TestApp;
  before(async () => {
    t = await startApp(
      { MAX_ROOMS: '6' },
      {
        files: {
          'index.html': '<!doctype html><title>x</title>',
          'assets/app.js': 'console.log(1)',
          'assets/style.css': 'a{}',
          'assets/shoot.wav': 'RIFF',
          'assets/pic.png': 'png',
        },
      },
    );
    await writeFile(join(t.root, 'secret.txt'), 'TOP SECRET');
  });
  after(() => t.close());

  test('GET /health', async () => {
    const response = await fetch(`${t.url}/health`);
    assert.equal(response.status, 200);
    const body = await readJson(response);
    assert.equal(body.status, 'ok');
    assert.equal(body.rooms, 4);
    assert.ok(body.rss > 0);
  });

  test('GET /api/rooms: список із реальною кількістю гравців', async () => {
    const response = await fetch(`${t.url}/api/rooms`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const rooms = await readJson(response);
    assert.deepEqual(
      rooms.map((r: Json) => r.id),
      ['training', 'belt', 'frontline', 'duel'],
    );
    assert.ok(rooms.every((r: Json) => r.players === 0));
  });

  test("POST /api/rooms: 201 + Location, кімната з'являється у списку", async () => {
    const response = await fetch(`${t.url}/api/rooms`, json({ name: 'Нова', maxPlayers: 3 }));
    assert.equal(response.status, 201);
    const room = await readJson(response);
    assert.equal(response.headers.get('location'), `/api/rooms/${room.id}`);
    assert.equal(room.maxPlayers, 3);

    const list = await readJson(await fetch(`${t.url}/api/rooms`));
    assert.ok(list.some((r: Json) => r.id === room.id));
    t.app.rooms.delete(room.id);
  });

  test('POST: 422 на невалідні дані, 400 на зламаний JSON, 415 без content-type', async () => {
    const invalid = await fetch(`${t.url}/api/rooms`, json({ name: '', maxPlayers: 99 }));
    assert.equal(invalid.status, 422);
    assert.equal((await readJson(invalid)).details.length, 2);

    assert.equal((await fetch(`${t.url}/api/rooms`, json('{oops'))).status, 400);
    assert.equal(
      (await fetch(`${t.url}/api/rooms`, { method: 'POST', body: '{"name":"x"}' })).status,
      415,
    );
  });

  test('POST: тіло більше 4 КБ → 413, і сервер лишається живим', async () => {
    const big = json({ name: 'x', pad: 'y'.repeat(10_000) });
    const response = await fetch(`${t.url}/api/rooms`, big);
    assert.equal(response.status, 413);
    assert.equal((await fetch(`${t.url}/health`)).status, 200);
  });

  test('POST: потокове тіло без Content-Length теж обмежене', async () => {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(t.port, '127.0.0.1', () => {
        socket.write(
          'POST /api/rooms HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
            'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n',
        );
        const chunk = 'a'.repeat(1000);
        for (let i = 0; i < 20; i++) socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      });
      let data = '';
      socket.on('data', (c: Buffer) => (data += c));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      setTimeout(() => reject(new Error('timeout')), 3000).unref();
    });
    assert.match(response, /^HTTP\/1\.1 413/);
    assert.equal((await fetch(`${t.url}/health`)).status, 200);
  });

  test('POST: ліміт кількості кімнат → 429', async () => {
    const made: string[] = [];
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${t.url}/api/rooms`, json({ name: `r${i}` }));
      if (response.status === 429) {
        assert.ok(made.length >= 1);
        for (const id of made) t.app.rooms.delete(id);
        return;
      }
      assert.equal(response.status, 201);
      made.push((await readJson(response)).id);
    }
    assert.fail('429 так і не прийшов');
  });

  test('методи та невідомі маршрути', async () => {
    const put = await fetch(`${t.url}/api/rooms`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.equal(put.headers.get('allow'), 'GET, POST');
    assert.equal((await fetch(`${t.url}/api/nope`)).status, 404);
    assert.equal((await fetch(`${t.url}/health`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${t.url}/index.html`, { method: 'POST' })).status, 405);
  });

  test('/api/slow вимкнений без DEMO_ENDPOINTS', async () => {
    assert.equal((await fetch(`${t.url}/api/slow`)).status, 404);
  });

  test('статика: MIME-типи, index.html для /, 404', async () => {
    const types: Record<string, string> = {
      '/': 'text/html; charset=utf-8',
      '/index.html': 'text/html; charset=utf-8',
      '/assets/app.js': 'text/javascript; charset=utf-8',
      '/assets/style.css': 'text/css; charset=utf-8',
      '/assets/shoot.wav': 'audio/wav',
      '/assets/pic.png': 'image/png',
    };
    for (const [path, type] of Object.entries(types)) {
      const response = await fetch(`${t.url}${path}`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), type, path);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      await response.arrayBuffer();
    }
    assert.equal((await fetch(`${t.url}/assets/nope.js`)).status, 404);
    assert.equal(await (await fetch(`${t.url}/assets/app.js`)).text(), 'console.log(1)');
  });

  test('path traversal: ".." у будь-якому вигляді відхиляється', async () => {
    const attacks = [
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..\\..\\secret.txt',
    ];
    for (const path of attacks) {
      const { status, data } = await rawRequest(t.port, path);
      assert.ok([400, 403].includes(status), `${path} → ${status}`);
      assert.ok(!data.includes('TOP SECRET'), `${path} віддав секрет`);
    }
    assert.equal((await rawRequest(t.port, '/%00')).status, 400);
    assert.equal((await rawRequest(t.port, '/%E0%A4%A')).status, 400);
  });

  test('resolveStaticPath: чиста функція', () => {
    const resolved = resolveStaticPath('/srv/dist', '/a/b.js?x=1');
    assert.equal(resolved.status, 200);
    assert(resolved.status === 200);
    assert.equal(resolved.path, '/srv/dist/a/b.js');
    assert.equal(resolveStaticPath('/srv/dist', '/../etc/passwd').status, 403);
    assert.equal(resolveStaticPath('/srv/dist', '/a/%2e%2e/b').status, 403);
    assert.equal(resolveStaticPath('/srv/dist', '/..hidden').status, 200, '"..hidden" — не ".."');
  });

  test('symlink усередині каталогу не веде назовні', async () => {
    const { symlink } = await import('node:fs/promises');
    await mkdir(join(t.config.staticDir, 'link-dir'), { recursive: true });
    await symlink(join(t.root, 'secret.txt'), join(t.config.staticDir, 'leak.txt'));
    const response = await fetch(`${t.url}/leak.txt`);
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes('TOP SECRET'));
  });
});

test('/api/slow із DEMO_ENDPOINTS=1 блокує цикл подій ~300 мс', async () => {
  const t = await startApp({ DEMO_ENDPOINTS: '1' });
  try {
    const body = await readJson(await fetch(`${t.url}/api/slow`));
    assert.ok(body.blockedMs >= 300 && body.blockedMs < 400, `blockedMs=${body.blockedMs}`);
  } finally {
    await t.close();
  }
});

test('якщо client/dist не зібрано — зрозуміла відповідь, а не crash', async () => {
  const t = await startApp({ STATIC_DIR: '/definitely/not/here' });
  try {
    const response = await fetch(`${t.url}/`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /npm run build/);
  } finally {
    await t.close();
  }
});
