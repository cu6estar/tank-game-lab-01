import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { describe, test } from 'vitest';
import { CLOSE } from '../src/protocol.ts';
import { connect, startApp } from './helpers.ts';

/** Спроба рукостискання: 'open' — пройшло, 'rejected' — сервер відмовив (не 101). */
function attempt(url: string, origin?: string): { socket: WebSocket; result: Promise<'open' | 'rejected'> } {
  const socket = new WebSocket(url, origin ? { headers: { origin } } : undefined);
  const result = new Promise<'open' | 'rejected'>((resolve) => {
    socket.on('open', () => resolve('open'));
    socket.on('unexpected-response', () => resolve('rejected'));
    socket.on('error', () => resolve('rejected'));
  });
  return { socket, result };
}

describe('Origin на рукостисканні', () => {
  test('дозволений Origin проходить, чужий — відхиляється', async () => {
    const app = await startApp({ ALLOWED_ORIGINS: 'https://game.example' });
    try {
      const ok = attempt(app.wsUrl, 'https://game.example');
      assert.equal(await ok.result, 'open');
      ok.socket.close();

      const bad = attempt(app.wsUrl, 'https://evil.example');
      assert.equal(await bad.result, 'rejected');

      const none = attempt(app.wsUrl); // без Origin (не браузер) — теж відхиляємо
      assert.equal(await none.result, 'rejected');
    } finally {
      await app.close();
    }
  });

  test('порожній список — будь-який Origin проходить (dev)', async () => {
    const app = await startApp();
    try {
      const a = attempt(app.wsUrl, 'https://whatever.example');
      assert.equal(await a.result, 'open');
      a.socket.close();
    } finally {
      await app.close();
    }
  });
});

describe('Ліміт з’єднань з однієї IP', () => {
  test('понад MAX_CONNECTIONS_PER_IP відхиляється', async () => {
    const app = await startApp({ MAX_CONNECTIONS_PER_IP: '2' });
    const open: WebSocket[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const a = attempt(app.wsUrl);
        assert.equal(await a.result, 'open', `з'єднання ${i} мало пройти`);
        open.push(a.socket);
      }
      const third = attempt(app.wsUrl);
      assert.equal(await third.result, 'rejected', 'третє понад ліміт — відмова');
    } finally {
      for (const s of open) s.close();
      await app.close();
    }
  });
});

describe('Ендпоінти моніторингу', () => {
  test('/health віддає git SHA; /ready — ready; /metrics — зведення', async () => {
    const app = await startApp({ GIT_SHA: 'deadbee' });
    try {
      const health = (await (await fetch(`${app.url}/health`)).json()) as { sha: string; status: string };
      assert.equal(health.sha, 'deadbee');
      assert.equal(health.status, 'ok');

      const ready = await fetch(`${app.url}/ready`);
      assert.equal(ready.status, 200);
      assert.equal(((await ready.json()) as { status: string }).status, 'ready');

      const metrics = (await (await fetch(`${app.url}/metrics`)).json()) as {
        rooms: number;
        eventLoopLagMs: { mean: number };
        memoryMB: unknown;
      };
      assert.ok('rooms' in metrics && 'eventLoopLagMs' in metrics && 'memoryMB' in metrics, JSON.stringify(metrics));
      assert.equal(typeof metrics.eventLoopLagMs.mean, 'number');
    } finally {
      await app.close();
    }
  });

  test('/ready стає 503 під час зупинки', async () => {
    const app = await startApp();
    const closing = app.close(); // стартуємо зупинку
    const ready = await fetch(`${app.url}/ready`).catch(() => null);
    if (ready) assert.equal(ready.status, 503, 'під час drain /ready = 503');
    await closing;
  });
});

describe('Флуд битих кадрів', () => {
  test('флудер відключається; інша кімната й час її кроку не страждають', async () => {
    const app = await startApp({ RATE_LIMIT_PER_SEC: '50' });
    try {
      // жертва-свідок у своїй кімнаті — має пережити флуд у сусідній
      const witness = connect(app.wsUrl);
      await witness.join('belt', 'Witness');

      // флудер заходить в іншу кімнату й сипле ~1000 битих кадрів
      const flooder = connect(app.wsUrl);
      await flooder.join('frontline', 'Flooder');
      for (let i = 0; i < 1000; i++) {
        if (flooder.socket.readyState !== WebSocket.OPEN) break;
        flooder.socket.send(`{битий кадр ${i}`);
      }

      // сервер його відключає (битий кадр / ліміт), а не ковтає й не падає
      const closed = await flooder.closed;
      const policyCodes: number[] = [CLOSE.BAD_MESSAGE, CLOSE.RATE_LIMIT, CLOSE.UNKNOWN_TYPE];
      assert.ok(policyCodes.includes(closed.code), `флудер мав закритися політикою, а не ${closed.code}`);

      // свідок досі живий: chat доходить (кімната обслуговується як завжди)
      witness.send({ type: 'chat', text: 'я тут' });
      const chat = await witness.waitForType('chat');
      assert.equal(chat.text, 'я тут');

      // і час кроку по всіх матчах лишається мізерним (флуд його не роздув)
      const metrics = (await (await fetch(`${app.url}/metrics`)).json()) as { tickMsMax: number };
      assert.ok(metrics.tickMsMax < 10, `tickMsMax роздувся: ${metrics.tickMsMax} мс`);
    } finally {
      await app.close();
    }
  });
});
