import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Lobby,
  LobbyDataError,
  normalizeName,
  parseRooms,
} from '../src/lobby.js';
import { fakeNetwork, hang, json, settleTicks, text, wait } from './helpers.js';

const ROOMS = [
  { id: 'a', name: 'Alpha', players: 1, maxPlayers: 4, arena: { enemies: 3 } },
  { id: 'b', name: 'Beta', players: 4, maxPlayers: 4, arena: {} },
];

/** Збирає події лобі: log.roomsChanged, log.error… */
function record(lobby, types = ['loading', 'roomsChanged', 'error', 'joined']) {
  const log = Object.fromEntries(types.map((type) => [type, []]));
  for (const type of types) {
    lobby.addEventListener(type, (event) => log[type].push(event.detail));
  }
  return log;
}

const makeLobby = (fetch, options = {}) =>
  new Lobby({
    url: '/api/rooms',
    intervalMs: 20,
    timeoutMs: 50,
    fetch,
    ...options,
  });

// ----------------------------------------------------------------- parseRooms

describe('parseRooms / normalizeName', () => {
  it('приймає масив, відкидає некоректні записи', () => {
    const rooms = parseRooms([
      ...ROOMS,
      { id: 5 },
      null,
      { id: 'x', name: 'x', players: 'багато', maxPlayers: 4 },
    ]);
    assert.deepEqual(
      rooms.map((room) => room.id),
      ['a', 'b'],
    );
  });

  it('не масив → LobbyDataError; усі записи погані → LobbyDataError', () => {
    assert.throws(() => parseRooms({ rooms: [] }), LobbyDataError);
    assert.throws(() => parseRooms('oops'), LobbyDataError);
    assert.throws(() => parseRooms([{ nope: 1 }]), LobbyDataError);
    assert.deepEqual(parseRooms([]), []);
  });

  it("ім'я: пробіли, довжина, значення за замовчуванням", () => {
    assert.equal(normalizeName('  Ivan   Petrenko  '), 'Ivan Petrenko');
    assert.equal(normalizeName('x'.repeat(40)).length, 16);
    assert.equal(normalizeName('   '), 'Pilot');
    assert.equal(normalizeName(undefined), 'Pilot');
  });
});

// -------------------------------------------------------------------- refresh

describe('Lobby.refresh', () => {
  it('успіх → roomsChanged зі списком, lobby.rooms оновлено', async () => {
    const lobby = makeLobby(fakeNetwork(() => json(ROOMS)));
    const log = record(lobby);

    await lobby.refresh();

    assert.equal(log.roomsChanged.length, 1);
    assert.deepEqual(
      log.roomsChanged[0].map((room) => room.id),
      ['a', 'b'],
    );
    assert.equal(log.error.length, 0);
    assert.equal(lobby.rooms.length, 2);
    assert.equal(lobby.pending, false);
  });

  it('кожен запит має signal і ліміт часу (AbortSignal.timeout)', async () => {
    const fetch = fakeNetwork(() => json(ROOMS));
    const lobby = makeLobby(fetch);
    await lobby.refresh();

    assert.ok(fetch.calls[0].signal instanceof AbortSignal);
  });

  it('404 / 500 → подія error з HttpError, не виняток', async () => {
    for (const status of [404, 500]) {
      const lobby = makeLobby(fakeNetwork(() => text('x', status)));
      const log = record(lobby);

      await lobby.refresh();

      assert.equal(log.roomsChanged.length, 0);
      assert.equal(log.error.length, 1);
      assert.equal(log.error[0].name, 'HttpError');
      assert.equal(log.error[0].status, status);
    }
  });

  it('битий JSON → error (BadJsonError), старі кімнати лишаються', async () => {
    let call = 0;
    const lobby = makeLobby(
      fakeNetwork(() => (++call === 1 ? json(ROOMS) : text('{"id": [broken'))),
    );
    const log = record(lobby);

    await lobby.refresh();
    await lobby.refresh();

    assert.equal(log.error[0].name, 'BadJsonError');
    assert.equal(lobby.rooms.length, 2, 'не затираємо останні добрі дані');
  });

  it('валідний JSON неправильної форми → LobbyDataError', async () => {
    const lobby = makeLobby(fakeNetwork(() => json({ rooms: 'нема' })));
    const log = record(lobby);
    await lobby.refresh();
    assert.equal(log.error[0].name, 'LobbyDataError');
  });

  it('мережа лягла (TypeError) → error', async () => {
    const lobby = makeLobby(
      fakeNetwork(() => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const log = record(lobby);
    await lobby.refresh();
    assert.equal(log.error[0].name, 'TypeError');
  });

  it('зависла відповідь → TimeoutError через timeoutMs', async () => {
    const lobby = makeLobby(fakeNetwork(hang), { timeoutMs: 30 });
    const log = record(lobby);

    await lobby.refresh();

    assert.equal(log.error.length, 1);
    assert.equal(log.error[0].name, 'TimeoutError');
    assert.equal(lobby.pending, false);
  });

  it('новий refresh скасовує попередній; тиші про скасування — жодної помилки', async () => {
    const fetch = fakeNetwork((url, init, n) =>
      n === 1 ? hang(url, init) : json(ROOMS),
    );
    const lobby = makeLobby(fetch, { timeoutMs: 5000 });
    const log = record(lobby);

    const first = lobby.refresh();
    await settleTicks();
    assert.equal(lobby.pending, true);

    const second = lobby.refresh();
    await Promise.all([first, second]);

    assert.equal(fetch.calls[0].signal.aborted, true, 'старий запит скасовано');
    assert.equal(fetch.calls[1].signal.aborted, false);
    assert.equal(log.error.length, 0, 'abort — не помилка для гравця');
    assert.equal(log.roomsChanged.length, 1);
  });

  it('запізніла відповідь старого запиту не затирає свіжіші дані', async () => {
    // перший fetch "не слухає" abort і відповість пізно — гірший випадок
    let releaseStale;
    const fetch = fakeNetwork((url, init, n) =>
      n === 1
        ? new Promise((resolve) => {
            releaseStale = () => resolve(json([ROOMS[1]]));
          })
        : json([ROOMS[0]]),
    );
    const lobby = makeLobby(fetch, { timeoutMs: 5000 });
    const log = record(lobby);

    const first = lobby.refresh();
    await settleTicks();
    await lobby.refresh(); // свіжа відповідь: кімната "a"
    releaseStale(); // а тепер приходить стара: кімната "b"
    await first;

    assert.deepEqual(
      lobby.rooms.map((room) => room.id),
      ['a'],
    );
    assert.equal(log.roomsChanged.length, 1);
  });
});

// ------------------------------------------------------ start / stop / інтервал

describe('Lobby.start / stop', () => {
  it('start() оновлює одразу й далі по інтервалу', async () => {
    const fetch = fakeNetwork(() => json(ROOMS));
    const lobby = makeLobby(fetch, { intervalMs: 25 });

    lobby.start();
    assert.equal(lobby.running, true);
    await wait(140);
    lobby.stop();

    assert.ok(fetch.calls.length >= 4, `запитів: ${fetch.calls.length}`);
  });

  it('повторний start() не створює другого таймера', async () => {
    const fetch = fakeNetwork(() => json(ROOMS));
    const lobby = makeLobby(fetch, { intervalMs: 1000 });

    lobby.start();
    lobby.start();
    lobby.start();
    await settleTicks();
    lobby.stop();

    assert.equal(fetch.calls.length, 1);
  });

  it('stop() скасовує запит у польоті й зупиняє опитування', async () => {
    const fetch = fakeNetwork(hang);
    const lobby = makeLobby(fetch, { intervalMs: 20, timeoutMs: 5000 });
    const log = record(lobby);

    lobby.start();
    await settleTicks();
    assert.equal(lobby.pending, true);

    lobby.stop();
    assert.equal(lobby.running, false);
    assert.equal(lobby.pending, false);
    assert.equal(
      fetch.calls[0].signal.aborted,
      true,
      'жодних "осиротілих" запитів',
    );

    const callsAtStop = fetch.calls.length;
    await wait(100);
    assert.equal(
      fetch.calls.length,
      callsAtStop,
      'після stop нових запитів немає',
    );
    assert.equal(log.error.length, 0);
  });

  it('після помилки опитування триває і саме одужує', async () => {
    const fetch = fakeNetwork((url, init, n) =>
      n <= 2 ? text('down', 503) : json(ROOMS),
    );
    const lobby = makeLobby(fetch, { intervalMs: 20 });
    const log = record(lobby);

    lobby.start();
    await wait(150);
    lobby.stop();

    assert.ok(log.error.length >= 2);
    assert.ok(log.roomsChanged.length >= 1, 'самовідновлення без втручання');
  });
});

// ----------------------------------------------------------------------- join

describe('Lobby.join', () => {
  async function loadedLobby() {
    const lobby = makeLobby(fakeNetwork(() => json(ROOMS)));
    await lobby.refresh();
    return lobby;
  }

  it('подія joined із кімнатою, іменем і конфігом арени; опитування зупиняється', async () => {
    const lobby = await loadedLobby();
    const log = record(lobby);
    lobby.playerName = '  Ace   Pilot ';
    lobby.start();

    const result = lobby.join('a');

    assert.equal(log.joined.length, 1);
    assert.equal(log.joined[0].room.id, 'a');
    assert.equal(log.joined[0].name, 'Ace Pilot');
    assert.deepEqual(log.joined[0].arena, { enemies: 3 });
    assert.deepEqual(result, log.joined[0]);
    assert.equal(lobby.running, false);
    assert.equal(lobby.pending, false);
  });

  it('невідома або заповнена кімната → помилка, лобі не зупиняється', async () => {
    const lobby = await loadedLobby();
    lobby.start();

    assert.throws(() => lobby.join('zzz'), /не знайдено/);
    assert.throws(() => lobby.join('b'), /заповнена/);
    assert.equal(lobby.running, true);
    lobby.stop();
  });
});
