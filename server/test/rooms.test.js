import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Room,
  RoomError,
  RoomManager,
  seedRooms,
  validateRoomInput,
} from '../src/rooms.js';

function player(id, name = id) {
  const inbox = [];
  return {
    id,
    name,
    inbox,
    send: (message, options) => inbox.push({ message, options }),
  };
}

test('join/leave/chat: події, roster і chat розсилаються', () => {
  const room = new Room({ id: 'r', name: 'R', now: () => 1000 });
  const events = [];
  for (const type of ['open', 'join', 'leave', 'chat', 'empty']) {
    room.on(type, () => events.push(type));
  }
  const a = player('a');
  const b = player('b');

  room.join(a);
  room.join(b);
  room.chat('a', 'привіт');
  room.leave('a');
  room.leave('b');

  assert.deepEqual(events, [
    'open',
    'join',
    'join',
    'chat',
    'leave',
    'leave',
    'empty',
  ]);

  const aTypes = a.inbox.map((m) => m.message.type);
  assert.deepEqual(aTypes, ['roster', 'roster', 'chat']); // після leave('a') він уже не отримувач
  assert.deepEqual(
    a.inbox[1].message.players.map((p) => p.name),
    ['a', 'b'],
  );
  assert.deepEqual(a.inbox[2].message, {
    type: 'chat',
    from: { id: 'a', name: 'a' },
    text: 'привіт',
    t: 1000,
  });
  assert.equal(
    a.inbox[2].options.critical,
    false,
    'чат — некритичне повідомлення',
  );
});

test("'open' іде раніше за 'event' першого join — лог не втрачає початок матчу", () => {
  const room = new Room({ id: 'r', name: 'R' });
  const order = [];
  room.on('open', () => order.push('open'));
  room.on('event', (e) => order.push(e.type));
  room.join(player('a'));
  assert.deepEqual(order, ['open', 'join']);
});

test('повна кімната і дубль гравця — RoomError, а не падіння', () => {
  const room = new Room({ id: 'r', name: 'R', maxPlayers: 1 });
  room.join(player('a'));
  assert.throws(
    () => room.join(player('b')),
    (e) => e instanceof RoomError && e.code === 'full',
  );
  assert.throws(
    () => room.join(player('a')),
    (e) => e.code === 'duplicate',
  );
  assert.equal(room.size, 1);
});

test('зламаний отримувач не зупиняє розсилку іншим', () => {
  const room = new Room({ id: 'r', name: 'R' });
  const good = player('good');
  room.join({
    id: 'bad',
    name: 'bad',
    send() {
      throw new Error('boom');
    },
  });
  room.join(good);
  room.chat('good', 'hi');
  assert.ok(good.inbox.some((m) => m.message.type === 'chat'));
});

test('менеджер видаляє порожню кімнату, але не "permanent"', () => {
  const manager = new RoomManager();
  const temp = manager.create({ name: 'Temp', maxPlayers: 4 });
  const keep = manager.create({
    id: 'keep',
    name: 'Keep',
    maxPlayers: 4,
    permanent: true,
  });
  const deleted = [];
  manager.on('deleted', (room) => deleted.push(room.id));

  temp.join(player('a'));
  keep.join(player('a'));
  assert.equal(manager.get(temp.id), temp);

  temp.leave('a');
  keep.leave('a');
  assert.equal(manager.get(temp.id), undefined, 'порожня видалена');
  assert.equal(manager.get('keep'), keep, 'permanent залишилась');
  assert.deepEqual(deleted, [temp.id]);
});

test('ліміт кількості кімнат', () => {
  const manager = new RoomManager({ maxRooms: 2 });
  manager.create({ name: 'a', maxPlayers: 2 });
  manager.create({ name: 'b', maxPlayers: 2 });
  assert.throws(
    () => manager.create({ name: 'c', maxPlayers: 2 }),
    (e) => e.code === 'limit',
  );
});

test('seedRooms: чотири кімнати, у списку players = реальна кількість', () => {
  const manager = seedRooms(new RoomManager());
  const list = manager.list();
  assert.equal(list.length, 4);
  assert.ok(list.every((r) => r.players === 0 && typeof r.arena === 'object'));
});

test('validateRoomInput', () => {
  const limits = { maxPlayersPerRoom: 8 };
  assert.deepEqual(validateRoomInput({ name: '  Моя   арена ' }, limits), {
    ok: true,
    value: { name: 'Моя арена', maxPlayers: 8, arena: {} },
  });
  assert.equal(
    validateRoomInput({ name: 'x', maxPlayers: 9 }, limits).ok,
    false,
  );
  assert.equal(
    validateRoomInput({ name: 'x', maxPlayers: 2.5 }, limits).ok,
    false,
  );
  assert.equal(validateRoomInput({ name: '' }, limits).ok, false);
  assert.equal(validateRoomInput({ name: 'x'.repeat(41) }, limits).ok, false);
  assert.equal(
    validateRoomInput({ name: 'x', arena: { enemies: 999 } }, limits).ok,
    false,
  );
  assert.equal(
    validateRoomInput({ name: 'x', arena: { evil: 1 } }, limits).ok,
    false,
  );
  assert.equal(validateRoomInput([], limits).ok, false);
  assert.equal(validateRoomInput(null, limits).ok, false);
  assert.deepEqual(
    validateRoomInput({ name: 'x', arena: { enemies: 3 } }, limits).value.arena,
    {
      enemies: 3,
    },
  );
});
