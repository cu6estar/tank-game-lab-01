import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRng } from '../src/rng.ts';
import { Ship } from '../src/sim/ship.ts';
import { Vector2 } from '../src/sim/vector.ts';
import type { World } from '../src/sim/world.ts';
import { runScenario } from '../src/scenario.ts';

// Еталон, знятий у Node 22 і підтверджений у Chromium (див. tools/hash-chrome.mjs).
// Якщо змінили правила гри свідомо — перерахуйте: npm run hash -w shared.
export const GOLDEN = { seed: 20260, steps: 1000 };
export const GOLDEN_HASHES = ['c8fd2081', 'ab631000', '36a225cc', 'f8b64a88'];

describe('детермінізм симуляції', () => {
  it('той самий seed і ті самі вводи → однакові хеші на кожному чекпоінті', () => {
    const a = runScenario(GOLDEN);
    const b = runScenario(GOLDEN);
    assert.deepEqual(a.hashes, b.hashes);
    assert.equal(a.final, b.final);
    assert.deepEqual(
      a.hashes,
      GOLDEN_HASHES,
      'збігається з еталоном, знятим у Chromium',
    );
  });

  it('інший seed → інший стан (хеш справді чутливий)', () => {
    assert.notEqual(
      runScenario(GOLDEN).final,
      runScenario({ ...GOLDEN, seed: 1 }).final,
    );
  });

  it('хеш чутливий і до вводів: один змінений ввід змінює стан', () => {
    const base = runScenario({ ...GOLDEN, steps: 300 }).final;
    const other = runScenario({ ...GOLDEN, steps: 301 }).final;
    assert.notEqual(base, other);
  });

  it('стан не залежить від того, скільки ігор існує поруч (немає глобального лічильника id)', () => {
    const alone = runScenario({ ...GOLDEN, steps: 400 }).final;
    runScenario({ seed: 5, steps: 100 }); // "інша кімната" на тому ж сервері
    const afterOther = runScenario({ ...GOLDEN, steps: 400 }).final;
    assert.equal(alone, afterOther);
  });

  it('Math.random() усередині integrate ламає збіг — саме цю помилку ловить хеш', () => {
    const original = Ship.prototype.behave;
    Ship.prototype.behave = function (this: Ship, dt: number, world: World) {
      original.call(this, dt, world);
      this.vel = this.vel.add(new Vector2((Math.random() - 0.5) * 2, 0));
    };
    try {
      const a = runScenario({ ...GOLDEN, steps: 250 }).final;
      const b = runScenario({ ...GOLDEN, steps: 250 }).final;
      assert.notEqual(a, b, 'з Math.random два прогони розходяться');
    } finally {
      Ship.prototype.behave = original;
    }
  });

  it('PRNG: mulberry32 однаковий у кожному середовищі (відомі значення)', () => {
    const rng = createRng(1);
    const first = [rng(), rng(), rng()].map((x) => x.toFixed(10));
    assert.deepEqual(first, ['0.6270739406', '0.0027357212', '0.5274470400']);
    const again = createRng(1);
    assert.equal(again().toFixed(10), first[0]);
    assert.ok(
      [...Array(1000)].every(() => {
        const v = rng();
        return v >= 0 && v < 1;
      }),
    );
  });

  it('симуляція завантажується в Node без DOM: у globalThis немає window/document', () => {
    assert.equal(typeof window, 'undefined');
    assert.equal(typeof document, 'undefined');
    const { game } = runScenario({ steps: 60 });
    assert.ok(game.world.size > 0);
  });

  it('довгий прогін без NaN і з обмеженою кількістю сутностей', () => {
    const { game } = runScenario({ steps: 3000, players: 4 });
    assert.ok(game.world.size < 120, `сутностей: ${game.world.size}`);
    for (const e of game.world)
      assert.ok(Number.isFinite(e.pos.x + e.pos.y + e.angle), e.kind);
  });
});
