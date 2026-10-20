import { DT } from '@tank/shared/constants.js';
import { createRng } from '@tank/shared/rng.js';
import { seqNewer } from '@tank/shared/protocol/input.js';
import { EFFECT_TYPES } from '@tank/shared/sim/components.js';
import { Ship } from '@tank/shared/sim/ship.js';
import { Vector2, wrapAngle } from '@tank/shared/sim/vector.js';
import { World } from '@tank/shared/sim/world.js';

/** Корекція менша за це — згладжується; більша — це телепорт/респаун, показуємо одразу. */
export const SNAP_DISTANCE = 100;
/** Стала часу згладжування: за 3τ ≈ 100 мс помилка зникає на 95%. */
export const SMOOTH_TAU = 0.033;
const MAX_PENDING = 120; // 4 с вводів; більше — з'єднання все одно мертве

const EFFECT_FACTORIES = {
  shield: EFFECT_TYPES.shield,
  rapidFire: EFFECT_TYPES.rapidFire,
  homingShots: EFFECT_TYPES.homingShots,
};

/**
 * Клієнтське передбачення (client-side prediction) власного корабля.
 *
 * Використовує ТОЙ САМИЙ клас Ship і ТОЙ САМИЙ World із shared/, що й сервер —
 * у мінімальному світі, де є лише наш корабель. Тож, якщо симуляція
 * детермінована, одному й тому ж вводу відповідає той самий результат.
 *
 * Цикл:
 *   1. кожен крок клієнта: step(input) — рухаємо корабель одразу, ввід у `pending`;
 *   2. прийшов знімок: reconcile() — скидаємо корабель у стан сервера (авторитет),
 *      викидаємо підтверджені ввід (seq ≤ ack) і ПЕРЕГРАЄМО решту;
 *   3. різницю "було → стало" не показуємо стрибком, а вносимо в `offset`,
 *      який зникає за ~100 мс (згладжування).
 */
export class Predictor {
  constructor({ width, height, seed = 1 }) {
    this.size = { width, height };
    this.world = new World({ width, height, rand: createRng(seed) });
    this.intent = { throttle: 0, turn: 0, turretTurn: 0, fire: false };
    this.ship = null;
    this.pending = []; // ввід, ще не підтверджений сервером
    this.bullets = []; // локальні (передбачені) кулі: { seq, x, y, px, py, vx, vy, ttl }
    this.offset = { x: 0, y: 0, angle: 0, turret: 0 };
    this.lastCorrection = 0; // розмір останньої корекції, px
    this.replaying = false;
    this.enabled = true; // false = "тупий клієнт": лише облік вводів, без симуляції
    this.onFired = null; // (pos) => void — звук власного пострілу
    this.world.addEventListener('fired', (event) => {
      if (!this.replaying) this.onFired?.(event.detail.pos);
    });
  }

  get alive() {
    return this.ship !== null;
  }

  #spawn(state) {
    this.ship = new Ship({
      pos: new Vector2(state.x, state.y),
      angle: state.angle,
      team: 'me',
      controller: () => this.intent,
    });
    this.world.spawn(this.ship);
  }

  #despawn() {
    if (this.ship) this.world.despawn(this.ship.id);
    this.ship = null;
  }

  /** Скинути корабель у стан зі знімка (без перегравання). */
  #applyState(state) {
    const { ship } = this;
    ship.pos = new Vector2(state.x, state.y);
    ship.prevPos = ship.pos;
    ship.vel = new Vector2(state.vx, state.vy);
    ship.angle = state.angle;
    ship.prevAngle = state.angle;
    ship.turretAngle = state.turret;
    ship.prevTurretAngle = state.turret;
    ship.cooldown = state.cooldown;

    for (const [name, seconds] of [
      ['shield', state.shield],
      ['rapidFire', state.rapid],
      ['homingShots', state.homing],
    ]) {
      ship.detach(name);
      if (seconds > 0) {
        const effect = EFFECT_FACTORIES[name]();
        effect.remaining = seconds;
        ship.attach(name, effect);
      }
    }
  }

  /** Крок на ввід. Викликається на кожному кроці клієнта (30 Гц). */
  step(input) {
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (this.ship && this.enabled) this.#advance(input);
  }

  #advance(input) {
    this.intent = input;
    this.ship.inputSeq = input.seq;
    this.world.step(DT);

    // Куля, яку створив цей крок, віддаємо у список локальних куль: у світі
    // предиктора вона б зникла/перепрогралась разом із кораблем при reconcile.
    for (const bullet of [...this.world.ofKind('bullet')]) {
      if (!this.replaying && !bullet.has('homing')) {
        this.bullets.push({
          seq: input.seq,
          x: bullet.pos.x,
          y: bullet.pos.y,
          px: bullet.pos.x,
          py: bullet.pos.y,
          vx: bullet.vel.x,
          vy: bullet.vel.y,
          ttl: bullet.ttl,
        });
      }
      this.world.despawn(bullet.id);
    }
  }

  /** Рух локальних куль (прямий політ; homing-кулі показує лише сервер). */
  stepBullets() {
    const { width, height } = this.size;
    for (const b of this.bullets) {
      b.px = b.x;
      b.py = b.y;
      b.x = (((b.x + b.vx * DT) % width) + width) % width;
      b.y = (((b.y + b.vy * DT) % height) + height) % height;
      b.ttl -= DT;
    }
    this.bullets = this.bullets.filter((b) => b.ttl > 0);
  }

  /**
   * Звірка зі знімком сервера.
   * @param {object} snapshot  розкодований знімок
   * @param {number} slot      наш слот
   * @returns {number} розмір корекції в пікселях (для netgraph)
   */
  reconcile(snapshot, slot) {
    const mine = snapshot.players.find((p) => p.slot === slot);
    const state = snapshot.ships.find((s) => s.slot === slot);
    const ack = mine?.ack ?? -1;

    // підтверджені вводи більше не потрібні
    this.pending = this.pending.filter((input) => seqNewer(input.seq, ack));
    this.#dropConfirmedBullets(snapshot, slot, ack);

    if (!this.enabled) return 0;

    if (!state) {
      this.#despawn(); // знищені: чекаємо респауну
      this.lastCorrection = 0;
      return 0;
    }

    const respawned = !this.ship;
    const before = this.ship
      ? {
          x: this.ship.pos.x,
          y: this.ship.pos.y,
          angle: this.ship.angle,
          turret: this.ship.turretAngle,
        }
      : null;

    if (respawned) this.#spawn(state);
    this.#applyState(state);

    this.replaying = true;
    for (const input of this.pending) this.#advance(input);
    this.replaying = false;

    if (respawned || !before) {
      this.offset = { x: 0, y: 0, angle: 0, turret: 0 };
      this.lastCorrection = 0;
      return 0;
    }

    // Корекція = (де були) − (де стали). Додаємо до offset: малюємо "стара + offset",
    // і offset плавно йде до нуля.
    const { size } = this;
    const wrapDelta = (from, to, span) => {
      let d = from - to;
      if (d > span / 2) d -= span;
      else if (d < -span / 2) d += span;
      return d;
    };
    const dx = wrapDelta(before.x, this.ship.pos.x, size.width);
    const dy = wrapDelta(before.y, this.ship.pos.y, size.height);
    const distance = Math.hypot(dx, dy);

    if (distance > SNAP_DISTANCE) {
      this.offset = { x: 0, y: 0, angle: 0, turret: 0 };
    } else {
      this.offset.x += dx;
      this.offset.y += dy;
      this.offset.angle += wrapAngle(before.angle - this.ship.angle);
      this.offset.turret += wrapAngle(before.turret - this.ship.turretAngle);
    }
    this.lastCorrection = distance;
    return distance;
  }

  /**
   * Наша передбачена куля живе, поки сервер її "не бачив" (seq > ack) або поки
   * вона ще є у знімку. Зникла зі знімка після ack ⇒ влучила/вичерпала ttl.
   */
  #dropConfirmedBullets(snapshot, slot, ack) {
    const serverTags = new Set(
      snapshot.bullets.filter((b) => b.owner === slot).map((b) => b.tag),
    );
    this.bullets = this.bullets.filter(
      (b) => seqNewer(b.seq, ack) || serverTags.has(b.seq & 0xffff),
    );
  }

  /** Згладжування: затухання offset за dt секунд. */
  smooth(dt) {
    const k = Math.exp(-dt / SMOOTH_TAU);
    this.offset.x *= k;
    this.offset.y *= k;
    this.offset.angle *= k;
    this.offset.turret *= k;
  }

  /** Стан для малювання: інтерполяція між кроками клієнта + згладжена корекція. */
  visual(alpha) {
    const { ship, offset, size } = this;
    if (!ship) return null;
    const lerp = (a, b) => a + (b - a) * alpha;
    const wrap = (value, span) => ((value % span) + span) % span;
    const jumped =
      Math.abs(ship.pos.x - ship.prevPos.x) > size.width / 2 ||
      Math.abs(ship.pos.y - ship.prevPos.y) > size.height / 2;
    const base = jumped
      ? ship.pos
      : {
          x: lerp(ship.prevPos.x, ship.pos.x),
          y: lerp(ship.prevPos.y, ship.pos.y),
        };
    return {
      x: wrap(base.x + offset.x, size.width),
      y: wrap(base.y + offset.y, size.height),
      angle:
        ship.prevAngle +
        wrapAngle(ship.angle - ship.prevAngle) * alpha +
        offset.angle,
      turret:
        ship.prevTurretAngle +
        wrapAngle(ship.turretAngle - ship.prevTurretAngle) * alpha +
        offset.turret,
      effects: {
        shield: ship.getComponent('shield')?.remaining ?? 0,
        rapid: ship.getComponent('rapidFire')?.remaining ?? 0,
        homing: ship.getComponent('homingShots')?.remaining ?? 0,
      },
    };
  }
}
