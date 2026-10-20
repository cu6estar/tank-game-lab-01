import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atan2, cos, exp, hypot, sin } from '../src/math.js';

const close = (a, b, eps, label) =>
  assert.ok(
    Math.abs(a - b) <= eps,
    `${label}: ${a} vs ${b} (Δ=${Math.abs(a - b)})`,
  );

describe('детермінована математика', () => {
  it('sin/cos збігаються з Math.* до 1e-14 на густій сітці, включно з великими аргументами', () => {
    for (let x = -50; x <= 50; x += 0.0137) {
      close(sin(x), Math.sin(x), 1e-14, `sin(${x})`);
      close(cos(x), Math.cos(x), 1e-14, `cos(${x})`);
    }
    assert.equal(sin(0), 0);
    close(cos(0), 1, 4e-16, 'cos 0');
    close(sin(Math.PI / 2), 1, 1e-15, 'sin π/2');
  });

  it('atan2: усі чверті, осі та нуль', () => {
    for (let a = -3.14; a <= 3.14; a += 0.0173) {
      const y = Math.sin(a) * 3.7;
      const x = Math.cos(a) * 3.7;
      close(atan2(y, x), Math.atan2(y, x), 1e-14, `atan2 ${a}`);
    }
    assert.equal(atan2(0, 0), 0);
    close(atan2(1, 0), Math.PI / 2, 1e-15, '+Y');
    close(atan2(-1, 0), -Math.PI / 2, 1e-15, '-Y');
    close(atan2(0, -1), Math.PI, 1e-15, '-X');
  });

  it('exp: збігається з Math.exp (відносно 1e-14), у тому числі від’ємні аргументи', () => {
    for (let x = -30; x <= 30; x += 0.0311) {
      const expected = Math.exp(x);
      assert.ok(Math.abs(exp(x) - expected) <= expected * 1e-14, `exp(${x})`);
    }
    assert.equal(exp(0), 1);
    assert.equal(exp(-800), 0);
  });

  it('hypot — лише sqrt і множення', () => {
    assert.equal(hypot(3, 4), 5);
  });

  it('значення на фіксованих входах стабільні (запис біт-точних відповідей)', () => {
    // Це ті самі входи, що дали розбіжність Node/Chrome для Math.*: наші
    // функції мусять давати ОДНАКОВІ біти скрізь, тому порівнюємо з константами.
    const dv = new DataView(new ArrayBuffer(8));
    const hex = (x) => {
      dv.setFloat64(0, x, true);
      return dv.getBigUint64(0, true).toString(16);
    };
    assert.deepEqual(
      [sin(2.5), sin(0.7744), cos(0.1), exp(-0.2)].map(hex),
      EXPECTED_BITS,
    );
  });
});

const EXPECTED_BITS = [
  '3fe326af0dcfcaaf',
  '3fe6608fc0c8de3a',
  '3fefd712f9a817c0',
  '3fea330ad6166159',
];
