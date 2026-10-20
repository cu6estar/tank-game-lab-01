import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE, parseMessage } from '../src/protocol.js';

const join = (extra = {}) =>
  JSON.stringify({
    type: 'join',
    v: 2,
    room: 'training',
    name: 'Ivan',
    ...extra,
  });

test('коректні повідомлення проходять і нормалізуються', () => {
  assert.deepEqual(parseMessage(join({ name: '  Іван   Петренко ' })).message, {
    type: 'join',
    v: 2,
    room: 'training',
    name: 'Іван Петренко',
    codec: 'json',
  });
  assert.deepEqual(parseMessage('{"type":"chat","text":" hi "}').message, {
    type: 'chat',
    text: 'hi',
  });
  assert.deepEqual(parseMessage('{"type":"leave"}').message, { type: 'leave' });
});

test('зайві поля відкидаються (у кімнату потрапляє лише відома форма)', () => {
  const { message } = parseMessage('{"type":"chat","text":"x","admin":true}');
  assert.deepEqual(message, { type: 'chat', text: 'x' });
});

test("не JSON, не об'єкт, без type → BAD_MESSAGE", () => {
  for (const raw of [
    '{oops',
    '[]',
    '42',
    'null',
    '"join"',
    '{}',
    '{"type":5}',
  ]) {
    const result = parseMessage(raw);
    assert.equal(result.ok, false, raw);
    assert.equal(result.code, CLOSE.BAD_MESSAGE, raw);
  }
});

test('невідомий тип → UNKNOWN_TYPE', () => {
  const result = parseMessage('{"type":"fire"}');
  assert.equal(result.code, CLOSE.UNKNOWN_TYPE);
});

test('join: версія, довжина імені, керівні символи', () => {
  assert.equal(parseMessage(join({ v: 1 })).code, CLOSE.BAD_VERSION);
  assert.equal(parseMessage(join({ v: undefined })).code, CLOSE.BAD_VERSION);
  assert.equal(parseMessage(join({ name: '' })).code, CLOSE.BAD_MESSAGE);
  assert.equal(
    parseMessage(join({ name: 'x'.repeat(17) })).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    parseMessage(join({ name: 'a\u0000b' })).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(parseMessage(join({ name: 42 })).code, CLOSE.BAD_MESSAGE);
  assert.equal(parseMessage(join({ room: '' })).code, CLOSE.BAD_MESSAGE);
});

test('chat: порожній і задовгий текст', () => {
  assert.equal(
    parseMessage('{"type":"chat","text":"   "}').code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(
    parseMessage(JSON.stringify({ type: 'chat', text: 'x'.repeat(201) })).code,
    CLOSE.BAD_MESSAGE,
  );
  assert.equal(parseMessage('{"type":"chat"}').code, CLOSE.BAD_MESSAGE);
});

test('прототип-забруднення: __proto__ у повідомленні нічого не ламає', () => {
  const result = parseMessage(
    '{"type":"chat","text":"x","__proto__":{"isAdmin":true}}',
  );
  assert.equal(result.ok, true);
  assert.equal({}.isAdmin, undefined);
  assert.equal(result.message.isAdmin, undefined);
});
