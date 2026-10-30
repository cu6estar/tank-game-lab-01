import { seqTag } from '@tank/shared/brand.ts';
import type { Seq } from '@tank/shared/brand.ts';
import { DT } from '@tank/shared/constants.ts';
import { seqNewer } from '@tank/shared/protocol/input.ts';
import type { ClientInput, Snapshot, SnapshotShip } from '@tank/shared/protocol/types.ts';
import { createRng } from '@tank/shared/rng.ts';
import { EFFECT_TYPES } from '@tank/shared/sim/components.ts';
import type { Effect, PickupType } from '@tank/shared/sim/components.ts';
import type { Intent } from '@tank/shared/sim/controllers.ts';
import { Ship } from '@tank/shared/sim/ship.ts';
import { Vector2, wrapAngle } from '@tank/shared/sim/vector.ts';
import { World } from '@tank/shared/sim/world.ts';
import type { Size } from './interpolate.ts';

/** Корекція менша за це — згладжується; більша — це телепорт/респаун, показуємо одразу. */
export const SNAP_DISTANCE = 100;
/** Стала часу згладжування: за 3τ ≈ 100 мс помилка зникає на 95%. */
export const SMOOTH_TAU = 0.033;
const MAX_PENDING = 120; // 4 с вводів; більше — з'єднання все одно мертве

const EFFECT_FACTORIES: Record<PickupType, () => Effect> = {
  shield: EFFECT_TYPES.shield,
  rapidFire: EFFECT_TYPES.rapidFire,
  homingShots: EFFECT_TYPES.homingShots,
};

export interface PredictorOptions {
  readonly width: number;
  readonly height: number;
  readonly seed?: number;
}

export interface LocalBullet {
  seq: Seq;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  ttl: number;
}

export interface Offset {
  x: number;
  y: number;
  angle: number;
  turret: number;
}

export interface PredictedVisual {
  x: number;
  y: number;
  angle: number;
  turret: number;
  effects: { shield: number; rapid: number; homing: number };
}

const IDLE_INTENT: Intent = { throttle: 0, turn: 0, turretTurn: 0, fire: false };

/**
 * Клієнтське передбачення (client-side prediction) власного корабля. Використовує
 * ТОЙ САМИЙ клас Ship і World із shared/, що й сервер, у мінімальному світі.
 */
export class Predictor {
  readonly size: Size;
  readonly world: World;
  intent: Intent = IDLE_INTENT;
  ship: Ship | null = null;
  pending: ClientInput[] = []; // ввід, ще не підтверджений сервером
  bullets: LocalBullet[] = []; // локальні (передбачені) кулі
  offset: Offset = { x: 0, y: 0, angle: 0, turret: 0 };
  lastCorrection = 0; // розмір останньої корекції, px
  replaying = false;
  enabled = true; // false = "тупий клієнт": лише облік вводів, без симуляції
  onFired: ((pos: Vector2) => void) | null = null;

  constructor({ width, height, seed = 1 }: PredictorOptions) {
    this.size = { width, height };
    this.world = new World({ width, height, rand: createRng(seed) });
    this.world.on('fired', (detail) => {
      if (!this.replaying) this.onFired?.(detail.pos);
    });
  }

  get alive(): boolean {
    return this.ship !== null;
  }

  #spawn(state: SnapshotShip): void {
    const ship = new Ship({
      pos: new Vector2(state.x, state.y),
      angle: state.angle,
      team: 'p0', // у світі предиктора лише наш корабель — команда суто формальна
      controller: () => this.intent,
    });
    this.ship = ship;
    this.world.spawn(ship);
  }

  #despawn(): void {
    if (this.ship) this.world.despawn(this.ship.id);
    this.ship = null;
  }

  /** Скинути корабель у стан зі знімка (без перегравання). */
  #applyState(state: SnapshotShip): void {
    const ship = this.ship;
    if (!ship) return;
    ship.pos = new Vector2(state.x, state.y);
    ship.prevPos = ship.pos;
    ship.vel = new Vector2(state.vx, state.vy);
    ship.angle = state.angle;
    ship.prevAngle = state.angle;
    ship.turretAngle = state.turret;
    ship.prevTurretAngle = state.turret;
    ship.cooldown = state.cooldown;

    const effects: [PickupType, number][] = [
      ['shield', state.shield],
      ['rapidFire', state.rapid],
      ['homingShots', state.homing],
    ];
    for (const [name, seconds] of effects) {
      ship.detach(name);
      if (seconds > 0) {
        const effect = EFFECT_FACTORIES[name]();
        effect.remaining = seconds;
        ship.attach(name, effect);
      }
    }
  }

  /** Крок на ввід. Викликається на кожному кроці клієнта (30 Гц). */
  step(input: ClientInput): void {
    this.pending.push(input);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (this.ship && this.enabled) this.#advance(input);
  }

  #advance(input: ClientInput): void {
    const ship = this.ship;
    if (!ship) return;
    this.intent = input;
    ship.inputSeq = input.seq;
    this.world.step(DT);

    // Кулю, яку створив цей крок, віддаємо у список локальних куль (у світі
    // предиктора вона б зникла/перепрогралась разом із кораблем при reconcile).
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
  stepBullets(): void {
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

  /** Звірка зі знімком сервера. @returns розмір корекції в пікселях (для netgraph). */
  reconcile(snapshot: Snapshot, slot: number): number {
    const mine = snapshot.players.find((p) => p.slot === slot);
    const state = snapshot.ships.find((s) => s.slot === slot);
    const ack = mine?.ack;
    const isUnacked = (seq: Seq): boolean => ack === undefined || seqNewer(seq, ack);

    // підтверджені вводи більше не потрібні
    this.pending = this.pending.filter((input) => isUnacked(input.seq));
    this.#dropConfirmedBullets(snapshot, slot, ack);

    if (!this.enabled) return 0;

    if (!state) {
      this.#despawn(); // знищені: чекаємо респауну
      this.lastCorrection = 0;
      return 0;
    }

    const respawned = !this.ship;
    const before =
      this.ship !== null
        ? { x: this.ship.pos.x, y: this.ship.pos.y, angle: this.ship.angle, turret: this.ship.turretAngle }
        : null;

    if (respawned) this.#spawn(state);
    this.#applyState(state);

    this.replaying = true;
    for (const input of this.pending) this.#advance(input);
    this.replaying = false;

    const ship = this.ship;
    if (respawned || before === null || ship === null) {
      this.offset = { x: 0, y: 0, angle: 0, turret: 0 };
      this.lastCorrection = 0;
      return 0;
    }

    // Корекція = (де були) − (де стали). Додаємо до offset, який плавно йде до нуля.
    const { size } = this;
    const wrapDelta = (from: number, to: number, span: number): number => {
      let d = from - to;
      if (d > span / 2) d -= span;
      else if (d < -span / 2) d += span;
      return d;
    };
    const dx = wrapDelta(before.x, ship.pos.x, size.width);
    const dy = wrapDelta(before.y, ship.pos.y, size.height);
    const distance = Math.hypot(dx, dy);

    if (distance > SNAP_DISTANCE) {
      this.offset = { x: 0, y: 0, angle: 0, turret: 0 };
    } else {
      this.offset.x += dx;
      this.offset.y += dy;
      this.offset.angle += wrapAngle(before.angle - ship.angle);
      this.offset.turret += wrapAngle(before.turret - ship.turretAngle);
    }
    this.lastCorrection = distance;
    return distance;
  }

  /** Наша куля живе, поки сервер її "не бачив" (seq не підтверджено) або поки вона у знімку. */
  #dropConfirmedBullets(snapshot: Snapshot, slot: number, ack: Seq | undefined): void {
    const serverTags = new Set(snapshot.bullets.filter((b) => b.owner === slot).map((b) => b.tag));
    this.bullets = this.bullets.filter(
      (b) => ack === undefined || seqNewer(b.seq, ack) || serverTags.has(seqTag(b.seq)),
    );
  }

  /** Згладжування: затухання offset за dt секунд. */
  smooth(dt: number): void {
    const k = Math.exp(-dt / SMOOTH_TAU);
    this.offset.x *= k;
    this.offset.y *= k;
    this.offset.angle *= k;
    this.offset.turret *= k;
  }

  /** Стан для малювання: інтерполяція між кроками клієнта + згладжена корекція. */
  visual(alpha: number): PredictedVisual | null {
    const { ship, offset, size } = this;
    if (!ship) return null;
    const lerp = (a: number, b: number): number => a + (b - a) * alpha;
    const wrap = (value: number, span: number): number => ((value % span) + span) % span;
    const jumped =
      Math.abs(ship.pos.x - ship.prevPos.x) > size.width / 2 ||
      Math.abs(ship.pos.y - ship.prevPos.y) > size.height / 2;
    const base = jumped
      ? { x: ship.pos.x, y: ship.pos.y }
      : { x: lerp(ship.prevPos.x, ship.pos.x), y: lerp(ship.prevPos.y, ship.pos.y) };
    return {
      x: wrap(base.x + offset.x, size.width),
      y: wrap(base.y + offset.y, size.height),
      angle: ship.prevAngle + wrapAngle(ship.angle - ship.prevAngle) * alpha + offset.angle,
      turret: ship.prevTurretAngle + wrapAngle(ship.turretAngle - ship.prevTurretAngle) * alpha + offset.turret,
      effects: {
        shield: ship.getComponent('shield')?.remaining ?? 0,
        rapid: ship.getComponent('rapidFire')?.remaining ?? 0,
        homing: ship.getComponent('homingShots')?.remaining ?? 0,
      },
    };
  }
}
