import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { CLOSE } from '../src/protocol.ts';
import { connect, sleep, startApp } from './helpers.ts';
import type { TestApp } from './helpers.ts';

// Відповіді /api/rooms у тестах читаємо вільно.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

describe('WebSocket: кімнати і чат', () => {
  let t: TestApp;
  before(async () => {
    t = await startApp({ JOIN_TIMEOUT_MS: '250', RATE_LIMIT_PER_SEC: '10' });
  });
  after(() => t.close());

  test('двоє заходять в одну кімнату, бачать roster одне одного і чат', async () => {
    const a = connect(t.wsUrl);
    const b = connect(t.wsUrl);

    const welcomeA = await a.join('belt', 'Alice');
    assert.equal(welcomeA.you.name, 'Alice');
    assert.equal(welcomeA.room.id, 'belt');
    await a.waitFor((m) => m.type === 'roster' && m.players.length === 1);

    await b.join('belt', 'Bob');
    const roster = await a.waitFor((m) => m.type === 'roster' && m.players.length === 2);
    assert.deepEqual(
      roster.players.map((p: Json) => p.name),
      ['Alice', 'Bob'],
    );

    // welcome приходить раніше за roster
    const types = b.messages.map((m) => m.type);
    assert.ok(types.indexOf('welcome') < types.indexOf('roster'));

    a.send({ type: 'chat', text: 'привіт, Bob' });
    for (const client of [a, b]) {
      const chat = await client.waitForType('chat');
      assert.equal(chat.from.name, 'Alice');
      assert.equal(chat.text, 'привіт, Bob');
    }

    b.socket.close();
    await a.waitFor(
      (m) =>
        m.type === 'roster' &&
        m.players.length === 1 &&
        m.players[0].name === 'Alice' &&
        a.messages.indexOf(m) > 2,
    );
    assert.equal(t.app.rooms.get('belt')?.size, 1);
    a.socket.close();
    await a.closed;
  });

  test('GET /api/rooms показує реальну кількість гравців', async () => {
    const a = connect(t.wsUrl);
    await a.join('frontline', 'Counter');
    const rooms: Json = await (await fetch(`${t.url}/api/rooms`)).json();
    assert.equal(rooms.find((r: Json) => r.id === 'frontline').players, 1);
    a.socket.close();
    await a.closed;
    await sleep(20);
    const after: Json = await (await fetch(`${t.url}/api/rooms`)).json();
    assert.equal(after.find((r: Json) => r.id === 'frontline').players, 0);
  });

  test("мовчазне з'єднання закривається кодом JOIN_TIMEOUT", async () => {
    const started = Date.now();
    const c = connect(t.wsUrl);
    const { code } = await c.closed;
    assert.equal(code, CLOSE.JOIN_TIMEOUT);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 200 && elapsed < 1000, `elapsed=${elapsed}`);
    assert.equal((await c.waitForType('error')).code, CLOSE.JOIN_TIMEOUT);
  });

  test('join вчасно скасовує таймер', async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'Quick');
    await sleep(400); // довше за JOIN_TIMEOUT_MS
    assert.equal(c.socket.readyState, WebSocket.OPEN);
    c.socket.close();
    await c.closed;
  });

  const closesWith = (name: string, frames: string[], expected: number): void =>
    void test(name, async () => {
      const c = connect(t.wsUrl);
      await c.opened;
      for (const frame of frames) c.send(frame);
      assert.equal((await c.closed).code, expected);
    });

  closesWith('зламаний JSON → 4001', ['{oops'], CLOSE.BAD_MESSAGE);
  closesWith('невідомий тип → 4002', ['{"type":"teleport"}'], CLOSE.UNKNOWN_TYPE);
  closesWith('chat до join → 4001', ['{"type":"chat","text":"hi"}'], CLOSE.BAD_MESSAGE);
  closesWith('join без версії → 4006', ['{"type":"join","room":"belt","name":"x"}'], CLOSE.BAD_VERSION);
  closesWith('кімнати не існує → 4003', ['{"type":"join","v":2,"room":"nowhere","name":"x"}'], CLOSE.JOIN_REJECTED);

  test('бінарний кадр → 1003', async () => {
    const c = connect(t.wsUrl);
    await c.opened;
    c.socket.send(Buffer.from([1, 2, 3]));
    assert.equal((await c.closed).code, CLOSE.UNSUPPORTED_DATA);
  });

  test('завеликий кадр (> maxPayload) → 1009', async () => {
    const c = connect(t.wsUrl);
    await c.join();
    c.send(JSON.stringify({ type: 'chat', text: 'x'.repeat(t.config.maxPayloadBytes + 100) }));
    assert.equal((await c.closed).code, CLOSE.TOO_BIG);
  });

  test('повторний join → 4001', async () => {
    const c = connect(t.wsUrl);
    await c.join();
    c.send({ type: 'join', v: 2, room: 'belt', name: 'again' });
    assert.equal((await c.closed).code, CLOSE.BAD_MESSAGE);
  });

  test('заповнена кімната → 4003 (duel вміщує двох)', async () => {
    const [a, b, c] = [connect(t.wsUrl), connect(t.wsUrl), connect(t.wsUrl)];
    await a.join('duel', 'A');
    await b.join('duel', 'B');
    void c.opened.then(() => c.send({ type: 'join', v: 2, room: 'duel', name: 'C' }));
    const { code } = await c.closed;
    assert.equal(code, CLOSE.JOIN_REJECTED);
    assert.match((await c.waitForType('error')).message, /заповнена/);
    assert.equal(t.app.rooms.get('duel')?.size, 2, 'зайвий не потрапив у кімнату');
    for (const x of [a, b]) {
      x.socket.close();
      await x.closed;
    }
  });

  test('rate limit: понад 10 повідомлень/с → 4004, інші клієнти не зачеплені', async () => {
    const spammer = connect(t.wsUrl);
    const calm = connect(t.wsUrl);
    await spammer.join('training', 'Spam');
    await calm.join('training', 'Calm');

    for (let i = 0; i < 40; i++) spammer.send({ type: 'chat', text: `m${i}` });
    assert.equal((await spammer.closed).code, CLOSE.RATE_LIMIT);

    assert.equal(calm.socket.readyState, WebSocket.OPEN);
    calm.send({ type: 'chat', text: 'я ще тут' });
    await calm.waitFor((m) => m.type === 'chat' && m.text === 'я ще тут');
    calm.socket.close();
    await calm.closed;
  });

  test('leave прибирає гравця і закриває сокет нормально', async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'Leaver');
    c.send({ type: 'leave' });
    assert.equal((await c.closed).code, CLOSE.NORMAL);
    await sleep(20);
    assert.equal(t.app.rooms.get('training')?.size, 0);
  });

  test("обрив з'єднання без close-кадру не лишає привида в кімнаті і не валить сервер", async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'Ghost');
    c.socket.terminate(); // TCP обірвано без рукостискання
    await c.closed;
    await sleep(50);
    assert.equal(t.app.rooms.get('training')?.size, 0);
    assert.equal((await fetch(`${t.url}/health`)).status, 200);
  });

  test("'error' на сокеті не валить процес (listener є на кожному з'єднанні)", async () => {
    const c = connect(t.wsUrl);
    await c.join('training', 'Err');
    const [serverSocket] = [...t.app.ws.wss.clients];
    assert(serverSocket);
    assert.ok(serverSocket.listenerCount('error') >= 1);
    serverSocket.emit('error', new Error('синтетична помилка'));
    assert.equal(serverSocket.readyState, WebSocket.OPEN);
    c.socket.close();
    await c.closed;
  });

  test('сторонній шлях upgrade (не /ws) відхиляється', async () => {
    const c = connect(`ws://127.0.0.1:${t.port}/other`);
    await assert.rejects(c.opened);
  });
});

describe('heartbeat', () => {
  test('клієнт, що не відповідає pong, розривається після двох пропущених', async () => {
    const t = await startApp({ HEARTBEAT_MS: '40', MAX_MISSED_PONGS: '2', JOIN_TIMEOUT_MS: '5000' });
    try {
      const started = Date.now();
      const dead = connect(t.wsUrl, { autoPong: false });
      await dead.join('training', 'Dead');
      await dead.closed;
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 100 && elapsed < 600, `elapsed=${elapsed}`);
      await sleep(30);
      assert.equal(t.app.rooms.get('training')?.size, 0, 'мертвий гравець прибраний з кімнати');
    } finally {
      await t.close();
    }
  });

  test('живий клієнт (автоматичний pong) не розривається', async () => {
    const t = await startApp({ HEARTBEAT_MS: '40', MAX_MISSED_PONGS: '2' });
    try {
      const alive = connect(t.wsUrl);
      await alive.join('training', 'Alive');
      await sleep(400); // ~10 heartbeat-тиків
      assert.equal(alive.socket.readyState, WebSocket.OPEN);
      alive.socket.close();
      await alive.closed;
    } finally {
      await t.close();
    }
  });
});

describe('повільний клієнт', () => {
  test('bufferedAmount росте → некритичний чат відкидається, потім сокет закривається', async () => {
    const t = await startApp({
      SLOW_CLIENT_BYTES: '4096',
      KILL_CLIENT_BYTES: '200000',
      RATE_LIMIT_PER_SEC: '1000',
      MAX_PAYLOAD_BYTES: '4096',
    });
    try {
      const slow = connect(t.wsUrl);
      const talker = connect(t.wsUrl);
      await slow.join('training', 'Slow');
      await talker.join('training', 'Talker');

      // _socket — внутрішній TCP-сокет ws; типів на ньому немає, тож звужуємо вручну
      const underlying = (slow.socket as unknown as { _socket: { pause(): void } })._socket;
      underlying.pause(); // клієнт перестав читати з TCP

      const text = 'x'.repeat(180);
      for (let batch = 0; batch < 400 && slow.socket.readyState === WebSocket.OPEN; batch++) {
        for (let i = 0; i < 200; i++) talker.send({ type: 'chat', text });
        await sleep(210);
        if (t.app.ws.stats.closedByPolicy > 0) break;
      }

      assert.ok(t.app.ws.stats.dropped > 0, `dropped=${t.app.ws.stats.dropped}`);
      assert.equal(talker.socket.readyState, WebSocket.OPEN, 'здоровий клієнт не постраждав');
    } finally {
      await t.close();
    }
  });
});
