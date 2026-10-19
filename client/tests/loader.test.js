import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BadJsonError,
  DecodeError,
  HttpError,
  ManifestError,
  fetchChecked,
  fetchJson,
  isRetryable,
  loadAll,
  loadAudio,
  loadImage,
  loadJson,
  validateManifest,
  withRetry,
} from '../src/assets/loader.js';
import { fakeNetwork, hang, json, settleTicks, text } from './helpers.js';

// ------------------------------------------------------------------ helpers

const fastRetry = { attempts: 3, baseMs: 1, maxMs: 2 };
const fakeAudioContext = {
  decodeAudioData: async (data) => ({
    kind: 'AudioBuffer',
    bytes: data.byteLength,
  }),
};

// -------------------------------------------------------------- fetchJson

describe('fetchJson / fetchChecked', () => {
  it('повертає розібраний JSON при 200', async () => {
    const fetch = fakeNetwork(() => json({ a: 1 }));
    assert.deepEqual(await fetchJson('/x.json', { fetch }), { a: 1 });
  });

  it('404 — це помилка HttpError, а не "успішна" відповідь', async () => {
    const fetch = fakeNetwork(() => text('nope', 404));
    await assert.rejects(fetchJson('/missing.json', { fetch }), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 404);
      assert.equal(error.url, '/missing.json');
      return true;
    });
  });

  it('битий JSON → BadJsonError', async () => {
    const fetch = fakeNetwork(() => text('{not json'));
    await assert.rejects(fetchJson('/bad.json', { fetch }), BadJsonError);
  });

  it('передає signal у fetch і відхиляється з AbortError після abort', async () => {
    const controller = new AbortController();
    const fetch = fakeNetwork(hang);

    const promise = fetchJson('/slow.json', {
      fetch,
      signal: controller.signal,
    });
    assert.ok(fetch.calls[0].signal instanceof AbortSignal);

    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
  });

  it('timeoutMs обриває запит, що завис, з TimeoutError', async () => {
    const fetch = fakeNetwork(hang);
    await assert.rejects(fetchChecked('/hang', { fetch, timeoutMs: 30 }), {
      name: 'TimeoutError',
    });
  });
});

// ---------------------------------------------------------------- withRetry

describe('withRetry', () => {
  it('5xx повторює, поки не вдасться', async () => {
    const fetch = fakeNetwork((url, init, n) =>
      n < 3 ? text('boom', 503) : json({ ok: true }),
    );
    const retries = [];

    const result = await withRetry(() => fetchJson('/flaky', { fetch }), {
      ...fastRetry,
      onRetry: (info) => retries.push(info.attempt),
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(fetch.count('/flaky'), 3);
    assert.deepEqual(retries, [1, 2]);
  });

  it('4xx НЕ повторює: рівно один запит', async () => {
    for (const status of [400, 401, 403, 404, 429]) {
      const fetch = fakeNetwork(() => text('client error', status));
      await assert.rejects(
        withRetry(() => fetchJson('/c', { fetch }), fastRetry),
        { name: 'HttpError', status },
      );
      assert.equal(
        fetch.count('/c'),
        1,
        `status ${status} не мав повторюватись`,
      );
    }
  });

  it('мережеву помилку (TypeError) повторює', async () => {
    const fetch = fakeNetwork((url, init, n) => {
      if (n < 2) throw new TypeError('Failed to fetch');
      return json({ ok: 1 });
    });
    assert.deepEqual(
      await withRetry(() => fetchJson('/net', { fetch }), fastRetry),
      { ok: 1 },
    );
    assert.equal(fetch.count('/net'), 2);
  });

  it('після вичерпання спроб кидає останню помилку', async () => {
    const fetch = fakeNetwork(() => text('down', 500));
    await assert.rejects(
      withRetry(() => fetchJson('/down', { fetch }), fastRetry),
      { name: 'HttpError', status: 500 },
    );
    assert.equal(fetch.count('/down'), 3);
  });

  it('таймаут запиту вважається тимчасовим збоєм', async () => {
    let calls = 0;
    const fetch = fakeNetwork((url, init) => {
      calls += 1;
      return calls < 2 ? hang(url, init) : json({ late: true });
    });

    const result = await withRetry(
      () => fetchJson('/t', { fetch, timeoutMs: 20 }),
      fastRetry,
    );
    assert.deepEqual(result, { late: true });
    assert.equal(calls, 2);
  });

  it('пауза росте експоненційно й обмежена maxMs (jitter = 1 → максимум)', async () => {
    const delays = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new HttpError('/x', 503);
        },
        {
          attempts: 5,
          baseMs: 100,
          maxMs: 450,
          random: () => 1,
          sleep: async (ms) => delays.push(ms),
        },
      ),
    );
    assert.deepEqual(delays, [100, 200, 400, 450]);
  });

  it('jitter масштабує паузу: random()=0 → 0, 0.5 → половина стелі', async () => {
    const run = async (random) => {
      const delays = [];
      await assert.rejects(
        withRetry(
          async () => {
            throw new HttpError('/x', 500);
          },
          {
            attempts: 3,
            baseMs: 100,
            random,
            sleep: async (ms) => delays.push(ms),
          },
        ),
      );
      return delays;
    };

    assert.deepEqual(await run(() => 0), [0, 0]);
    assert.deepEqual(await run(() => 0.5), [50, 100]);
  });

  it('справжній jitter: паузи різні й лежать у [0, стеля]', async () => {
    const delays = [];
    for (let i = 0; i < 40; i++) {
      await assert.rejects(
        withRetry(
          async () => {
            throw new HttpError('/x', 500);
          },
          { attempts: 2, baseMs: 1000, sleep: async (ms) => delays.push(ms) },
        ),
      );
    }
    assert.ok(delays.every((ms) => ms >= 0 && ms <= 1000));
    assert.ok(new Set(delays).size > 20, 'jitter має давати різні значення');
  });

  it('abort під час паузи між спробами перериває її одразу', async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = performance.now();

    const promise = withRetry(
      async () => {
        calls += 1;
        throw new HttpError('/x', 503);
      },
      {
        attempts: 5,
        baseMs: 10_000,
        random: () => 1,
        signal: controller.signal,
      },
    );

    setTimeout(() => controller.abort(), 20);
    await assert.rejects(promise, { name: 'AbortError' });

    assert.equal(calls, 1, 'нових спроб після abort бути не повинно');
    assert.ok(performance.now() - started < 1000, 'не чекали 10 с');
  });

  it('abort до старту — навіть перша спроба не виконується', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => (calls += 1), { signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal(calls, 0);
  });
});

describe('isRetryable', () => {
  it('таблиця рішень', () => {
    assert.equal(isRetryable(new HttpError('/', 500)), true);
    assert.equal(isRetryable(new HttpError('/', 503)), true);
    assert.equal(isRetryable(new HttpError('/', 404)), false);
    assert.equal(isRetryable(new HttpError('/', 400)), false);
    assert.equal(isRetryable(new TypeError('Failed to fetch')), true);
    assert.equal(
      isRetryable(Object.assign(new Error(), { name: 'TimeoutError' })),
      true,
    );
    assert.equal(isRetryable(new BadJsonError('/')), false);
    assert.equal(isRetryable(new DecodeError('/')), false);
    assert.equal(isRetryable(new Error('щось інше')), false);

    const aborted = new AbortController();
    aborted.abort();
    assert.equal(isRetryable(new HttpError('/', 503), aborted.signal), false);
  });
});

// ------------------------------------------------------------------ лоадери

describe('loadImage / loadAudio / loadJson', () => {
  it('loadImage: fetch → blob → decodeImage', async () => {
    const fetch = fakeNetwork(() => text('PNGDATA'));
    const bitmap = await loadImage('/s.png', {
      fetch,
      decodeImage: async (blob) => ({ kind: 'bitmap', size: blob.size }),
    });
    assert.deepEqual(bitmap, { kind: 'bitmap', size: 7 });
  });

  it('loadImage: 404 не повторюється', async () => {
    const fetch = fakeNetwork(() => text('', 404));
    await assert.rejects(
      loadImage('/nope.png', {
        fetch,
        retry: fastRetry,
        decodeImage: async () => 1,
      }),
      { name: 'HttpError', status: 404 },
    );
    assert.equal(fetch.count('/nope.png'), 1);
  });

  it('loadImage: битий файл → DecodeError без ретраю', async () => {
    const fetch = fakeNetwork(() => text('garbage'));
    await assert.rejects(
      loadImage('/bad.png', {
        fetch,
        retry: fastRetry,
        decodeImage: async () => {
          throw new Error('cannot decode');
        },
      }),
      DecodeError,
    );
    assert.equal(fetch.count('/bad.png'), 1);
  });

  it('loadAudio: декодує через AudioContext', async () => {
    const fetch = fakeNetwork(() => text('RIFF....'));
    const buffer = await loadAudio(fakeAudioContext, '/a.wav', { fetch });
    assert.deepEqual(buffer, { kind: 'AudioBuffer', bytes: 8 });
  });

  it('loadAudio: abort — запит скасовується', async () => {
    const controller = new AbortController();
    const fetch = fakeNetwork(hang);
    const promise = loadAudio(fakeAudioContext, '/a.wav', {
      fetch,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
  });

  it('loadJson: 503 → ретрай → успіх', async () => {
    const fetch = fakeNetwork((url, init, n) =>
      n === 1 ? text('', 503) : json({ ok: true }),
    );
    assert.deepEqual(await loadJson('/j', { fetch, retry: fastRetry }), {
      ok: true,
    });
    assert.equal(fetch.count('/j'), 2);
  });

  it('retry: false вимикає повтори', async () => {
    const fetch = fakeNetwork(() => text('', 503));
    await assert.rejects(loadJson('/j', { fetch, retry: false }), HttpError);
    assert.equal(fetch.count('/j'), 1);
  });
});

// ----------------------------------------------------------------- loadAll

const manifestOf = (...assets) => ({ assets });
const asset = (key, type, extra = {}) => ({
  key,
  type,
  url: `/${key}`,
  ...extra,
});

describe('loadAll', () => {
  it('стартує ВСІ запити одночасно (до відповіді на будь-який)', async () => {
    const gates = new Map();
    const fetch = fakeNetwork(
      (url) =>
        new Promise((resolve) => {
          gates.set(url, () => resolve(json({ url })));
        }),
    );
    const manifest = manifestOf(
      asset('a', 'json'),
      asset('b', 'json'),
      asset('c', 'json'),
      asset('d', 'json'),
    );

    const promise = loadAll(manifest, { fetch });
    await settleTicks();

    assert.equal(fetch.calls.length, 4, 'усі 4 fetch вже в польоті');
    for (const release of gates.values()) release();

    const assets = await promise;
    assert.deepEqual(Object.keys(assets.json), ['a', 'b', 'c', 'd']);
  });

  it('прогрес рахується по кожному файлу: 1/n, 2/n … n/n', async () => {
    const releases = [];
    const fetch = fakeNetwork(
      () => new Promise((resolve) => releases.push(() => resolve(json({})))),
    );
    const manifest = manifestOf(
      asset('a', 'json'),
      asset('b', 'json'),
      asset('c', 'json'),
      asset('d', 'json'),
    );
    const progress = [];

    const promise = loadAll(manifest, {
      fetch,
      onProgress: (fraction, info) => progress.push([fraction, info.entry.key]),
    });
    await settleTicks();

    // відповідаємо в зворотному порядку — прогрес однаково зростає
    for (const release of releases.reverse()) {
      release();
      await settleTicks();
    }
    await promise;

    assert.deepEqual(
      progress.map(([fraction]) => fraction),
      [0.25, 0.5, 0.75, 1],
    );
    assert.deepEqual(
      progress.map(([, key]) => key),
      ['d', 'c', 'b', 'a'],
    );
  });

  it("збій обов'язкового файлу → reject і скасування решти запитів", async () => {
    const fetch = fakeNetwork((url, init) =>
      url === '/bad' ? text('', 404) : hang(url, init),
    );
    const manifest = manifestOf(
      asset('bad', 'json'),
      asset('slow1', 'json'),
      asset('slow2', 'json'),
    );

    await assert.rejects(loadAll(manifest, { fetch }), {
      name: 'HttpError',
      status: 404,
    });

    const slow = fetch.calls.filter((c) => c.url !== '/bad');
    assert.equal(slow.length, 2);
    assert.ok(
      slow.every((c) => c.signal.aborted),
      'решта завантажень мала бути скасована',
    );
  });

  it("404 обов'язкового файлу не повторюється", async () => {
    const fetch = fakeNetwork((url) =>
      url === '/bad' ? text('', 404) : json({}),
    );
    await assert.rejects(
      loadAll(manifestOf(asset('bad', 'json'), asset('ok', 'json')), {
        fetch,
        retry: fastRetry,
      }),
      HttpError,
    );
    assert.equal(fetch.count('/bad'), 1);
  });

  it('optional-файл при збої дає null, прогрес доходить до 1', async () => {
    const fetch = fakeNetwork((url) =>
      url === '/sfx' ? text('', 404) : json({ ok: url }),
    );
    const manifest = manifestOf(
      asset('data', 'json'),
      asset('sfx', 'json', { optional: true }),
    );
    const progress = [];

    const assets = await loadAll(manifest, {
      fetch,
      retry: false,
      onProgress: (fraction, info) => progress.push([fraction, info.ok]),
    });

    assert.equal(assets.json.sfx, null);
    assert.deepEqual(assets.json.data, { ok: '/data' });
    assert.equal(assets.failed.length, 1);
    assert.equal(assets.failed[0].entry.key, 'sfx');
    assert.equal(progress.at(-1)[0], 1);
    assert.deepEqual(progress.map(([, ok]) => ok).sort(), [false, true]);
  });

  it('5xx ретраїться всередині loadAll і повідомляє через onRetry', async () => {
    const fetch = fakeNetwork((url, init, n) =>
      n < 3 ? text('', 502) : json({ done: true }),
    );
    const retries = [];

    const assets = await loadAll(manifestOf(asset('flaky', 'json')), {
      fetch,
      retry: fastRetry,
      onRetry: (entry, info) => retries.push([entry.key, info.attempt]),
    });

    assert.deepEqual(assets.json.flaky, { done: true });
    assert.deepEqual(retries, [
      ['flaky', 1],
      ['flaky', 2],
    ]);
  });

  it('зовнішній abort скасовує все завантаження', async () => {
    const controller = new AbortController();
    const fetch = fakeNetwork(hang);

    const promise = loadAll(
      manifestOf(asset('a', 'json'), asset('b', 'image')),
      { fetch, signal: controller.signal },
    );
    await settleTicks();
    controller.abort();

    await assert.rejects(promise, { name: 'AbortError' });
    assert.ok(fetch.calls.every((c) => c.signal.aborted));
  });

  it('abort до старту — жодного запиту', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = fakeNetwork(() => json({}));

    await assert.rejects(
      loadAll(manifestOf(asset('a', 'json')), {
        fetch,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    assert.equal(fetch.calls.length, 0);
  });

  it('розкладає результат за типами: images / audio / json', async () => {
    const fetch = fakeNetwork((url) =>
      url === '/atlas' ? json({ f: 1 }) : text('data'),
    );
    const assets = await loadAll(
      manifestOf(
        asset('atlas', 'json'),
        asset('sheet', 'image'),
        asset('boom', 'audio'),
      ),
      {
        fetch,
        audioContext: fakeAudioContext,
        decodeImage: async () => ({ kind: 'bitmap' }),
      },
    );
    assert.deepEqual(assets.json.atlas, { f: 1 });
    assert.deepEqual(assets.images.sheet, { kind: 'bitmap' });
    assert.equal(assets.audio.boom.kind, 'AudioBuffer');
  });
});

describe('validateManifest', () => {
  it('приймає коректний і відхиляє некоректні', () => {
    assert.ok(validateManifest(manifestOf(asset('a', 'json'))));
    assert.throws(() => validateManifest(null), ManifestError);
    assert.throws(() => validateManifest({}), ManifestError);
    assert.throws(
      () =>
        validateManifest(manifestOf({ key: 'x', type: 'video', url: '/x' })),
      ManifestError,
    );
    assert.throws(
      () =>
        validateManifest(manifestOf(asset('a', 'json'), asset('a', 'image'))),
      /дубль/,
    );
  });
});
