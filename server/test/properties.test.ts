import assert from 'node:assert/strict';
import fc from 'fast-check';
import { test } from 'vitest';

import { parseClientMessage, PROTOCOL_VERSION } from '../src/protocol.ts';

// Властивісний тест парсера (межа процесу): він приймає будь-яке правильне
// повідомлення, відхиляє зіпсоване і НІКОЛИ не кидає — лише повертає ParseResult.

const RUNS = { numRuns: 400 };

// рядок, що лишається валідним після trim/collapse: лише літери й цифри
const token = (max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
      minLength: 1,
      maxLength: max,
    })
    .map((chars) => chars.join(''));

const axis = fc.constantFrom(-1, 0, 1);

const inputObj = fc.record({
  seq: fc.integer({ min: 0, max: 0xfffffffe }),
  throttle: axis,
  turn: axis,
  turretTurn: axis,
  fire: fc.boolean(),
});

const validMessage: fc.Arbitrary<{ type: string }> = fc.oneof(
  fc.record({
    type: fc.constant('join'),
    v: fc.constant(PROTOCOL_VERSION),
    room: token(64),
    name: token(16),
    codec: fc.constantFrom('json', 'binary'),
  }),
  fc.record({ type: fc.constant('chat'), text: token(200) }),
  fc.record({ type: fc.constant('leave') }),
  fc.record({ type: fc.constant('ping'), t: fc.integer({ min: 0, max: 2 ** 40 }) }),
  fc.record({ type: fc.constant('input'), inputs: fc.array(inputObj, { minLength: 1, maxLength: 8 }) }),
);

test('property: кожне правильне повідомлення приймається, тип зберігається', () => {
  fc.assert(
    fc.property(validMessage, (message) => {
      const result = parseClientMessage(message);
      assert.ok(result.ok, `відхилено валідне: ${JSON.stringify(message)}`);
      assert.equal(result.message.type, message.type);
    }),
    RUNS,
  );
});

test('property: будь-який вхід не валить парсер (повертає ParseResult, не кидає)', () => {
  fc.assert(
    fc.property(fc.anything(), (anything) => {
      const result = parseClientMessage(anything);
      assert.equal(typeof result.ok, 'boolean');
    }),
    RUNS,
  );
});

test('property: зіпсовані повідомлення відхиляються (ok: false)', () => {
  const corrupted = fc.oneof(
    // не-об'єкт
    fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.array(fc.anything())),
    // невідомий тип
    fc.record({ type: token(10).filter((s) => !['join', 'chat', 'leave', 'ping', 'input'].includes(s)) }),
    // join із неправильною версією
    fc.record({ type: fc.constant('join'), v: fc.integer().filter((v) => v !== PROTOCOL_VERSION), room: token(10), name: token(10) }),
    // chat із порожнім текстом
    fc.record({ type: fc.constant('chat'), text: fc.constantFrom('', '   ', '\u0000') }),
    // input без вводів
    fc.record({ type: fc.constant('input'), inputs: fc.constant([]) }),
  );
  fc.assert(
    fc.property(corrupted, (message) => {
      assert.equal(parseClientMessage(message).ok, false, `пропущено зіпсоване: ${JSON.stringify(message)}`);
    }),
    RUNS,
  );
});
