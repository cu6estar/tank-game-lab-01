import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Connection, backoffDelay } from '../src/net/connection.ts';
import type { ConnectionOptions, SocketCtor } from '../src/net/connection.ts';

interface SentMsg {
  type?: string;
  text?: string;
}

/** Фейковий WebSocket: тест сам вирішує, коли він відкривається й закривається. */
class FakeSocket extends EventTarget {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  binaryType: BinaryType = 'blob';
  sent: SentMsg[] = [];
  url: string;

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: send до відкриття');
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  receive(message: unknown): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data: typeof message === 'string' ? message : JSON.stringify(message) }));
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }
}

interface PendingTimer {
  fn: (() => void) | null;
  ms: number;
}

/** Керований таймер: пауза reconnect минає, лише коли тест скаже. */
function fakeTimers() {
  const pending: PendingTimer[] = [];
  return {
    setTimeout: (fn: () => void, ms: number): number => (pending.push({ fn, ms }), pending.length),
    clearTimeout: (id: unknown): void => {
      const t = pending[(id as number) - 1];
      if (t) t.fn = null;
    },
    pending,
    fire(): number | undefined {
      const next = pending.shift();
      next?.fn?.();
      return next?.ms;
    },
  };
}

type EventDetail = { attempt?: number; delayMs?: number; code?: number; reason?: string; raw?: string } | undefined;

function make(options: Partial<ConnectionOptions> = {}) {
  FakeSocket.instances.length = 0;
  const timers = fakeTimers();
  const connection = new Connection({
    url: 'ws://x/ws',
    WebSocketImpl: FakeSocket as unknown as SocketCtor, // as: фейк замість браузерного WebSocket
    timers,
    backoff: { baseMs: 100, maxMs: 1000, random: () => 1 }, // без jitter: пауза = стеля
    handshake: () => ({ type: 'join', room: 'r' }),
    ...options,
  });
  const events: [string, EventDetail][] = [];
  const types = ['open', 'close', 'reconnecting', 'fatal', 'protocolerror'] as const;
  for (const type of types) {
    connection.addEventListener(type, (e) => events.push([type, e.detail]));
  }
  return { connection, timers, events, sockets: FakeSocket.instances };
}

/** Непорожній сокет за індексом. */
function sock(sockets: FakeSocket[], i: number): FakeSocket {
  const s = sockets[i];
  assert(s, `немає сокета ${i}`);
  return s;
}

describe('backoffDelay', () => {
  it('стеля росте вдвічі й упирається в maxMs', () => {
    const opts = { baseMs: 100, maxMs: 1000, random: () => 1 };
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, opts)),
      [100, 200, 400, 800, 1000, 1000],
    );
  });

  it('jitter: пауза лежить у [стеля/2, стеля]', () => {
    const lo = backoffDelay(3, { baseMs: 100, maxMs: 1000, random: () => 0 });
    const hi = backoffDelay(3, { baseMs: 100, maxMs: 1000, random: () => 1 });
    assert.deepEqual([lo, hi], [200, 400]);
  });
});

describe('Connection', () => {
  it('диспетчер: повідомлення розходяться за type, відписка працює', () => {
    const { connection, sockets } = make();
    const seen: [string, string | number][] = [];
    const off = connection.on<{ type: string; text: string }>('chat', (m) => seen.push(['chat', m.text]));
    connection.on<{ type: string; players: unknown[] }>('roster', (m) => seen.push(['roster', m.players.length]));
    connection.connect();
    sock(sockets, 0).open();

    sock(sockets, 0).receive({ type: 'chat', text: 'a' });
    sock(sockets, 0).receive({ type: 'roster', players: [1, 2] });
    sock(sockets, 0).receive({ type: 'невідомий' });
    off();
    sock(sockets, 0).receive({ type: 'chat', text: 'b' });

    assert.deepEqual(seen, [
      ['chat', 'a'],
      ['roster', 2],
    ]);
  });

  it("зламані кадри дають protocolerror і не ламають з'єднання", () => {
    const { connection, sockets, events } = make();
    connection.connect();
    sock(sockets, 0).open();
    sock(sockets, 0).receive('{oops');
    sock(sockets, 0).receive('[1]');
    sock(sockets, 0).receive({ type: 'x' });
    assert.equal(events.filter(([t]) => t === 'protocolerror').length, 2);
    assert.equal(connection.state, 'open');
  });

  it('виняток в одному обробнику не глушить інші', () => {
    const { connection, sockets } = make();
    const seen: string[] = [];
    connection.on('chat', () => {
      throw new Error('boom');
    });
    connection.on('chat', () => seen.push('second'));
    connection.connect();
    sock(sockets, 0).open();

    const original = console.error;
    console.error = () => {};
    try {
      sock(sockets, 0).receive({ type: 'chat' });
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, ['second']);
  });

  it('send до відкриття йде в чергу; після open — спершу handshake, потім черга по порядку', () => {
    const { connection, sockets } = make();
    assert.equal(connection.send({ type: 'chat', text: '0' }), 'queued', 'ще не connect()');
    connection.connect();
    assert.equal(connection.send({ type: 'chat', text: '1' }), 'queued');
    assert.equal(connection.queued, 2);

    sock(sockets, 0).open();
    assert.deepEqual(
      sock(sockets, 0).sent.map((m) => m.text ?? m.type),
      ['join', '0', '1'],
    );
    assert.equal(connection.queued, 0);
    assert.equal(connection.send({ type: 'chat', text: '2' }), 'sent');
  });

  it('черга обмежена: понад maxQueue повідомлення відкидаються', () => {
    const { connection } = make({ maxQueue: 2 });
    connection.connect();
    assert.deepEqual(
      [1, 2, 3].map((i) => connection.send({ type: 'chat', text: `${i}` })),
      ['queued', 'queued', 'dropped'],
    );
  });

  it('обрив → reconnecting з наростаючою паузою → повторне підключення з новим handshake', () => {
    const { connection, timers, events, sockets } = make();
    connection.connect();
    sock(sockets, 0).open();

    sock(sockets, 0).drop(1006);
    assert.equal(connection.state, 'reconnecting');
    assert.equal(sockets.length, 1, 'нового сокета ще немає: чекаємо паузу');

    assert.equal(connection.send({ type: 'chat', text: 'offline' }), 'queued');

    assert.equal(timers.fire(), 100);
    assert.equal(sockets.length, 2);
    sock(sockets, 1).drop(1006);
    assert.equal(timers.fire(), 200);
    sock(sockets, 2).drop(1006);
    assert.equal(timers.fire(), 400);

    sock(sockets, 3).open();
    assert.deepEqual(
      sock(sockets, 3).sent.map((m) => m.text ?? m.type),
      ['join', 'offline'],
      'join знову першим, відкладене чат-повідомлення — після нього',
    );

    const attempts = events.filter(([t]) => t === 'reconnecting').map(([, d]) => d?.attempt);
    assert.deepEqual(attempts, [1, 2, 3]);

    sock(sockets, 3).drop(1006);
    assert.equal(timers.fire(), 100);
  });

  it('close() — остаточно: таймер скасовано, чергу скинуто, пізні події ігноруються', () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sock(sockets, 0).open();
    sock(sockets, 0).drop(1006);
    connection.close();

    timers.fire();
    assert.equal(sockets.length, 1);
    assert.equal(connection.state, 'closed');
    assert.equal(connection.send({ type: 'chat', text: 'x' }), 'dropped');
  });

  it("повторне підключення не стартує після навмисного close() з відкритого з'єднання", () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sock(sockets, 0).open();
    connection.close();
    assert.equal(timers.pending.length, 0);
    assert.equal(sockets.length, 1);
  });

  it('фатальний код (4003 — кімнату відхилено) не повторюється', () => {
    const { connection, timers, events, sockets } = make();
    connection.connect();
    sock(sockets, 0).open();
    connection.send({ type: 'chat', text: 'буде скинуто' });
    sock(sockets, 0).drop(4003);

    assert.equal(connection.state, 'closed');
    assert.equal(timers.pending.length, 0, 'таймера перепідключення немає');
    assert.deepEqual(events.at(-1), ['fatal', { code: 4003, reason: '' }]);
  });

  it('1001 (сервер перезапускається) — повторюємо', () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sock(sockets, 0).open();
    sock(sockets, 0).drop(1001);
    assert.equal(connection.state, 'reconnecting');
    timers.fire();
    assert.equal(sockets.length, 2);
  });

  it('запізнілі події старого сокета не псують новий', () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sock(sockets, 0).open();
    sock(sockets, 0).drop(1006);
    timers.fire();
    sock(sockets, 1).open();

    sock(sockets, 0).receive({ type: 'chat', text: 'привид' });
    sock(sockets, 0).drop(1006);
    assert.equal(connection.state, 'open');
    assert.equal(timers.pending.length, 0);
  });
});
