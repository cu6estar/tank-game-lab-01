import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBucket } from '../src/ratelimit.ts';
import { slowClientAction } from '../src/policy.ts';

function clock() {
  let t = 0;
  const now = () => t;
  now.advance = (ms: number) => (t += ms);
  return now;
}

test('сплеск до capacity дозволений, далі відмова', () => {
  const now = clock();
  const bucket = new TokenBucket({ capacity: 5, ratePerSec: 5, now });
  const results = Array.from({ length: 7 }, () => bucket.take());
  assert.deepEqual(results, [true, true, true, true, true, false, false]);
});

test('жетони поповнюються з часом, але не вище capacity', () => {
  const now = clock();
  const bucket = new TokenBucket({ capacity: 4, ratePerSec: 2, now });
  for (let i = 0; i < 4; i++) bucket.take();
  assert.equal(bucket.take(), false);

  now.advance(500); // +1 жетон
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);

  now.advance(60_000);
  assert.equal(bucket.tokens <= 4, true);
  bucket.take();
  assert.ok(bucket.tokens <= 3 + 1e-9, 'не накопичуємо понад capacity');
});

test('стала швидкість нижче ліміту проходить безкінечно', () => {
  const now = clock();
  const bucket = new TokenBucket({ capacity: 3, ratePerSec: 10, now });
  for (let i = 0; i < 100; i++) {
    now.advance(100); // 10/с — рівно ліміт
    assert.equal(bucket.take(), true);
  }
});

test('slowClientAction: send / drop / kill', () => {
  const base = { slowBytes: 1000, killBytes: 5000 };
  assert.equal(
    slowClientAction({ ...base, buffered: 0, critical: false }),
    'send',
  );
  assert.equal(
    slowClientAction({ ...base, buffered: 1000, critical: false }),
    'send',
  );
  assert.equal(
    slowClientAction({ ...base, buffered: 1001, critical: false }),
    'drop',
  );
  assert.equal(
    slowClientAction({ ...base, buffered: 1001, critical: true }),
    'send',
  );
  assert.equal(
    slowClientAction({ ...base, buffered: 5001, critical: true }),
    'kill',
  );
});
