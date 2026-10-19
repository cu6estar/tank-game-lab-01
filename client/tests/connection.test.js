import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Connection, backoffDelay } from '../src/net/connection.js';

/** Фейковий WebSocket: тест сам вирішує, коли він відкривається й закривається. */
class FakeSocket extends EventTarget {
  static instances = [];
  static OPEN = 1;
  readyState = 0;
  sent = [];
  constructor(url) {
    super();
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data) {
    if (this.readyState !== 1)
      throw new Error('InvalidStateError: send до відкриття');
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }
  // ---- методи "сервера"
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  receive(message) {
    this.dispatchEvent(
      Object.assign(new Event('message'), {
        data: typeof message === 'string' ? message : JSON.stringify(message),
      }),
    );
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason: '' }));
  }
}

/** Керований таймер: пауза reconnect минає, лише коли тест скаже. */
function fakeTimers() {
  const pending = [];
  return {
    setTimeout: (fn, ms) => pending.push({ fn, ms }) && pending.length,
    clearTimeout: (id) => {
      if (pending[id - 1]) pending[id - 1].fn = null;
    },
    pending,
    fire() {
      const next = pending.shift();
      next?.fn?.();
      return next?.ms;
    },
  };
}

function make(options = {}) {
  FakeSocket.instances.length = 0;
  const timers = fakeTimers();
  const connection = new Connection({
    url: 'ws://x/ws',
    WebSocketImpl: FakeSocket,
    timers,
    backoff: { baseMs: 100, maxMs: 1000, random: () => 1 }, // без jitter: пауза = стеля
    handshake: () => ({ type: 'join', room: 'r' }),
    ...options,
  });
  const events = [];
  for (const type of [
    'open',
    'close',
    'reconnecting',
    'fatal',
    'protocolerror',
  ]) {
    connection.addEventListener(type, (e) => events.push([type, e.detail]));
  }
  return { connection, timers, events, sockets: FakeSocket.instances };
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
    const seen = [];
    const off = connection.on('chat', (m) => seen.push(['chat', m.text]));
    connection.on('roster', (m) => seen.push(['roster', m.players.length]));
    connection.connect();
    sockets[0].open();

    sockets[0].receive({ type: 'chat', text: 'a' });
    sockets[0].receive({ type: 'roster', players: [1, 2] });
    sockets[0].receive({ type: 'невідомий' }); // ніхто не слухає — не помилка
    off();
    sockets[0].receive({ type: 'chat', text: 'b' });

    assert.deepEqual(seen, [
      ['chat', 'a'],
      ['roster', 2],
    ]);
  });

  it("зламані кадри дають protocolerror і не ламають з'єднання", () => {
    const { connection, sockets, events } = make();
    connection.connect();
    sockets[0].open();
    sockets[0].receive('{oops');
    sockets[0].receive('[1]'); // JSON, але без type
    sockets[0].receive({ type: 'x' });
    assert.equal(events.filter(([t]) => t === 'protocolerror').length, 2);
    assert.equal(connection.state, 'open');
  });

  it('виняток в одному обробнику не глушить інші', () => {
    const { connection, sockets } = make();
    const seen = [];
    connection.on('chat', () => {
      throw new Error('boom');
    });
    connection.on('chat', () => seen.push('second'));
    connection.connect();
    sockets[0].open();

    const original = console.error;
    console.error = () => {};
    try {
      sockets[0].receive({ type: 'chat' });
    } finally {
      console.error = original;
    }
    assert.deepEqual(seen, ['second']);
  });

  it('send до відкриття йде в чергу; після open — спершу handshake, потім черга по порядку', () => {
    const { connection, sockets } = make();
    assert.equal(
      connection.send({ type: 'chat', text: '0' }),
      'queued',
      'ще не connect()',
    );
    connection.connect();
    assert.equal(connection.send({ type: 'chat', text: '1' }), 'queued');
    assert.equal(connection.queued, 2);

    sockets[0].open();
    assert.deepEqual(
      sockets[0].sent.map((m) => m.text ?? m.type),
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
    sockets[0].open();

    sockets[0].drop(1006);
    assert.equal(connection.state, 'reconnecting');
    assert.equal(sockets.length, 1, 'нового сокета ще немає: чекаємо паузу');

    // друге повідомлення поки зв'язку немає — в чергу
    assert.equal(connection.send({ type: 'chat', text: 'offline' }), 'queued');

    assert.equal(timers.fire(), 100); // 1-ша пауза
    assert.equal(sockets.length, 2);
    sockets[1].drop(1006); // сервер ще лежить
    assert.equal(timers.fire(), 200); // 2-га пауза вдвічі довша
    sockets[2].drop(1006);
    assert.equal(timers.fire(), 400);

    sockets[3].open(); // сервер повернувся
    assert.deepEqual(
      sockets[3].sent.map((m) => m.text ?? m.type),
      ['join', 'offline'],
      'join знову першим, відкладене чат-повідомлення — після нього',
    );

    const attempts = events
      .filter(([t]) => t === 'reconnecting')
      .map(([, d]) => d.attempt);
    assert.deepEqual(attempts, [1, 2, 3]);

    // успіх скидає лічильник: наступний обрив знову починає зі 100 мс
    sockets[3].drop(1006);
    assert.equal(timers.fire(), 100);
  });

  it('close() — остаточно: таймер скасовано, чергу скинуто, пізні події ігноруються', () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sockets[0].open();
    sockets[0].drop(1006);
    connection.close();

    timers.fire(); // скасований таймер нічого не робить
    assert.equal(sockets.length, 1);
    assert.equal(connection.state, 'closed');
    assert.equal(connection.send({ type: 'chat', text: 'x' }), 'dropped');
  });

  it("повторне підключення не стартує після навмисного close() з відкритого з'єднання", () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sockets[0].open();
    connection.close();
    assert.equal(timers.pending.length, 0);
    assert.equal(sockets.length, 1);
  });

  it('фатальний код (4003 — кімнату відхилено) не повторюється', () => {
    const { connection, timers, events, sockets } = make();
    connection.connect();
    sockets[0].open();
    connection.send({ type: 'chat', text: 'буде скинуто' });
    sockets[0].drop(4003);

    assert.equal(connection.state, 'closed');
    assert.equal(timers.pending.length, 0, 'таймера перепідключення немає');
    assert.deepEqual(events.at(-1), ['fatal', { code: 4003, reason: '' }]);
  });

  it('1001 (сервер перезапускається) — повторюємо', () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sockets[0].open();
    sockets[0].drop(1001);
    assert.equal(connection.state, 'reconnecting');
    timers.fire();
    assert.equal(sockets.length, 2);
  });

  it('запізнілі події старого сокета не псують новий', () => {
    const { connection, timers, sockets } = make();
    connection.connect();
    sockets[0].open();
    sockets[0].drop(1006);
    timers.fire();
    sockets[1].open();

    sockets[0].receive({ type: 'chat', text: 'привид' }); // старий сокет ще "говорить"
    sockets[0].drop(1006); // і ще раз "закривається"
    assert.equal(connection.state, 'open');
    assert.equal(timers.pending.length, 0);
  });
});
