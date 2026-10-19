import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';

test('значення за замовчуванням і абсолютні шляхи від baseDir', () => {
  const config = loadConfig({}, { baseDir: '/srv/app' });
  assert.equal(config.port, 3000);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.logDir, join('/srv/app', 'logs'));
  assert.equal(config.joinTimeoutMs, 5000);
  assert.equal(config.heartbeatMs, 15000);
  assert.equal(config.maxMissedPongs, 2);
});

test('конфіг заморожений: його не можна змінити "на льоту"', () => {
  const config = loadConfig({});
  assert.throws(() => {
    'use strict';
    config.port = 1;
  }, TypeError);
});

test('PORT і LOG_DIR із оточення', () => {
  const config = loadConfig({ PORT: '8080', LOG_DIR: '/var/log/tank' });
  assert.equal(config.port, 8080);
  assert.equal(config.logDir, '/var/log/tank');
});

test('некоректні значення перелічуються всі разом, а не по одному', () => {
  assert.throws(
    () => loadConfig({ PORT: 'abc', MAX_ROOMS: '0', DEMO_ENDPOINTS: 'maybe' }),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.problems.length, 3);
      assert.match(error.message, /PORT/);
      assert.match(error.message, /MAX_ROOMS/);
      assert.match(error.message, /DEMO_ENDPOINTS/);
      return true;
    },
  );
});

test('"12abc", "1e3", "" і "99999" не проходять як порт', () => {
  for (const PORT of ['12abc', '1e3', '99999', '-1', '3.5']) {
    assert.throws(() => loadConfig({ PORT }), ConfigError, `PORT=${PORT}`);
  }
  assert.equal(loadConfig({ PORT: '' }).port, 3000, 'порожнє = не задано');
});

test('KILL_CLIENT_BYTES має бути більшим за SLOW_CLIENT_BYTES', () => {
  assert.throws(
    () => loadConfig({ SLOW_CLIENT_BYTES: '5000', KILL_CLIENT_BYTES: '4000' }),
    /KILL_CLIENT_BYTES/,
  );
});
