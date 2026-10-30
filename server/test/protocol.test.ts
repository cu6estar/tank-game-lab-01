import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLOSE, parseMessage } from '../src/protocol.ts';
import type { ClientMessage, ParseResult } from '../src/protocol.ts';

const join = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'join', v: 2, room: 'training', name: 'Ivan', ...extra });

/** Повідомлення з успішного розбору (інакше падає тест). */
function messageOf(result: ParseResult): ClientMessage {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  return result.message;
}

/** Код закриття з невдалого розбору. */
function codeOf(result: ParseResult): number {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  return result.code;
}

test('коректні повідомлення проходять і нормалізуються', () => {
  assert.deepEqual(messageOf(parseMessage(join({ name: '  Іван   Петренко ' }))), {
    type: 'join',
    v: 2,
    room: 'training',
    name: 'Іван Петренко',
    codec: 'json',
  });
  assert.deepEqual(messageOf(parseMessage('{"type":"chat","text":" hi "}')), { type: 'chat', text: 'hi' });
  assert.deepEqual(messageOf(parseMessage('{"type":"leave"}')), { type: 'leave' });
});

test('зайві поля відкидаються (у кімнату потрапляє лише відома форма)', () => {
  const message = messageOf(parseMessage('{"type":"chat","text":"x","admin":true}'));
  assert.deepEqual(message, { type: 'chat', text: 'x' });
});

test("не JSON, не об'єкт, без type → BAD_MESSAGE", () => {
  for (const raw of ['{oops', '[]', '42', 'null', '"join"', '{}', '{"type":5}']) {
    assert.equal(codeOf(parseMessage(raw)), CLOSE.BAD_MESSAGE, raw);
  }
});

test('невідомий тип → UNKNOWN_TYPE', () => {
  assert.equal(codeOf(parseMessage('{"type":"fire"}')), CLOSE.UNKNOWN_TYPE);
});

test('join: версія, довжина імені, керівні символи', () => {
  assert.equal(codeOf(parseMessage(join({ v: 1 }))), CLOSE.BAD_VERSION);
  assert.equal(codeOf(parseMessage(join({ v: undefined }))), CLOSE.BAD_VERSION);
  assert.equal(codeOf(parseMessage(join({ name: '' }))), CLOSE.BAD_MESSAGE);
  assert.equal(codeOf(parseMessage(join({ name: 'x'.repeat(17) }))), CLOSE.BAD_MESSAGE);
  assert.equal(codeOf(parseMessage(join({ name: 'a\u0000b' }))), CLOSE.BAD_MESSAGE);
  assert.equal(codeOf(parseMessage(join({ name: 42 }))), CLOSE.BAD_MESSAGE);
  assert.equal(codeOf(parseMessage(join({ room: '' }))), CLOSE.BAD_MESSAGE);
});

test('chat: порожній і задовгий текст', () => {
  assert.equal(codeOf(parseMessage('{"type":"chat","text":"   "}')), CLOSE.BAD_MESSAGE);
  assert.equal(codeOf(parseMessage(JSON.stringify({ type: 'chat', text: 'x'.repeat(201) }))), CLOSE.BAD_MESSAGE);
  assert.equal(codeOf(parseMessage('{"type":"chat"}')), CLOSE.BAD_MESSAGE);
});

test('прототип-забруднення: __proto__ у повідомленні нічого не ламає', () => {
  const message = messageOf(parseMessage('{"type":"chat","text":"x","__proto__":{"isAdmin":true}}'));
  const probe: Record<string, unknown> = {};
  assert.equal(probe['isAdmin'], undefined);
  assert.equal((message as Record<string, unknown>)['isAdmin'], undefined);
});
