import { toSeq } from '@tank/shared/brand.ts';
import { CodecError, getCodec } from '@tank/shared/codec/index.ts';
import { peekType } from '@tank/shared/codec/index.ts';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_MS } from '@tank/shared/constants.ts';
import { EVENT, INPUT_REDUNDANCY, MAX_HP, MSG, NO_SLOT } from '@tank/shared/protocol/constants.ts';
import type { Axis, ClientInput, CodecName, Snapshot, SnapshotShip } from '@tank/shared/protocol/types.ts';
import type { Intent } from '@tank/shared/sim/controllers.ts';
import { createEffects } from '../fx.ts';
import type { ConnectionState } from './connection.ts';
import { interpolateSnapshot } from './interpolate.ts';
import { createLagInjector } from './lag.ts';
import type { LagConfig, LagInjector } from './lag.ts';
import type { PlayerRef, PongMessage, SnapshotMessage } from './messages.ts';
import { Predictor } from './predictor.ts';
import { joinRoomSession } from './room-session.ts';
import type { RoomSession, RoomUi } from './room-session.ts';
import { isMode, MODES } from './scene.ts';
import type { Mode, Scene, SceneBullet, SceneEvent, SceneShip } from './scene.ts';
import { SnapshotBuffer } from './snapshot-buffer.ts';
import { RateMeter, Smoothed } from './stats.ts';

export { MODES } from './scene.ts';

/** Затримка інтерполяції за замовчуванням, мс (див. README: вибір значення). */
export const DEFAULT_INTERP_DELAY = 100;
const PING_EVERY_MS = 500;
const SIZE = { width: ARENA_WIDTH, height: ARENA_HEIGHT };

const toAxis = (n: number): Axis => (n > 0 ? 1 : n < 0 ? -1 : 0);

export interface NetStats {
  mode: Mode;
  codec: CodecName;
  state: ConnectionState;
  slot: number | null;
  tick: number;
  rtt: number | null;
  rttAvg: number | null;
  snapshotAge: number | null;
  snapshotInterval: number | null;
  snapshotsPerSec: number;
  bytesIn: number;
  bytesOut: number;
  inputQueue: number;
  correction: number;
  correctionMax: number;
  delay: number;
  delaySetting: number;
  missed: number;
  starved: number;
  starvedNow: boolean;
  badFrames: number;
  buffered: number;
  lag: LagConfig;
  lagStats: { passed: number; dropped: number; delayed: number };
}

export interface NetGame {
  step(intent: Intent): void;
  frame(alpha: number, dt: number): Scene | null;
  stats(): NetStats;
  readonly lag: LagInjector;
  readonly session: RoomSession;
  readonly mode: Mode;
  setMode(next: string): void;
  readonly delayMs: number;
  setDelay(ms: number | string): void;
  readonly slot: number | null;
  readonly predictor: Predictor;
  readonly buffer: SnapshotBuffer;
  sendChat(text: string): 'sent' | 'queued' | 'dropped';
  leave(): void;
}

export interface NetGameOptions {
  readonly roomId: string;
  readonly name: string;
  readonly ui: RoomUi;
  readonly onRejected?: (info: { code: number; reason: string }) => void;
  readonly onEvent?: (event: SceneEvent) => void;
  readonly search?: string;
  readonly now?: () => number;
}

interface PendingEvent {
  t: number;
  event: SceneEvent;
}

/** Мережева частина клієнта гри: з'єднання, кодек, ввід із seq, передбачення, звірка, статистика. */
export function createNetGame({
  roomId,
  name,
  ui,
  onRejected,
  onEvent = () => {},
  search = globalThis.location?.search ?? '',
  now = () => performance.now(),
}: NetGameOptions): NetGame {
  const params = new URLSearchParams(search);
  const codecName: CodecName = params.get('codec') === 'json' ? 'json' : 'binary';
  const codec = getCodec(codecName);
  const lag = createLagInjector();
  lag.configureFromQuery(search);

  const rawMode = params.get('mode');
  let mode: Mode = isMode(rawMode) ? rawMode : 'full';
  let delayMs = Number(params.get('delay')) || DEFAULT_INTERP_DELAY;

  let me: PlayerRef | null = null;
  let slot: number | null = null;
  let seq = 0;
  let predictor = new Predictor({ ...SIZE });
  let buffer = new SnapshotBuffer();
  const recent: ClientInput[] = []; // останні ввід для надлишковості
  const effects = createEffects();
  let events: PendingEvent[] = []; // чекають моменту показу
  let lastSnapshotTick: number | null = null;
  let latest: Snapshot | null = null;

  const meters = {
    bytesIn: new RateMeter(),
    bytesOut: new RateMeter(),
    snapshots: new RateMeter(),
    rtt: new Smoothed({ alpha: 0.2 }),
    interval: new Smoothed({ alpha: 0.1 }),
    correction: new Smoothed({ alpha: 0.3 }),
  };
  const counters = { missed: 0, starved: 0, badFrames: 0 };
  let lastArrival: number | null = null;
  let frameStarved = false;

  predictor.enabled = mode !== 'dumb';

  // ------------------------------------------------------------ приймання

  function onSnapshot(snapshot: Snapshot, bytes: number): void {
    const t = now();
    const result = buffer.push(snapshot, t);
    meters.bytesIn.add(bytes, t);
    if (result !== 'ok') return;

    meters.snapshots.add(1, t);
    if (lastArrival !== null) meters.interval.add(t - lastArrival, t);
    lastArrival = t;
    if (lastSnapshotTick !== null) counters.missed += Math.max(0, snapshot.tick - lastSnapshotTick - 1);
    lastSnapshotTick = snapshot.tick;
    latest = snapshot;

    if (slot !== null) {
      const correction = predictor.reconcile(snapshot, slot);
      if (predictor.enabled) meters.correction.add(correction, t);
    }

    for (const event of snapshot.events) {
      events.push({ t: snapshot.tick * TICK_MS, event });
    }
  }

  function onBinary(frame: Uint8Array): void {
    try {
      switch (peekType(frame)) {
        case MSG.SNAPSHOT:
          return onSnapshot(codec.decodeSnapshot(frame), frame.byteLength);
        case MSG.PONG:
          return onPong(codec.decodePong(frame).echo);
        default:
          counters.badFrames += 1;
      }
    } catch (error: unknown) {
      if (!(error instanceof CodecError)) throw error;
      counters.badFrames += 1;
      console.warn('[net] битий кадр:', error.message);
    }
  }

  function onPong(echo: number): void {
    const t = now();
    meters.rtt.add(t - (echo >>> 0), t);
  }

  // ------------------------------------------------------------ сесія

  const session = joinRoomSession({
    roomId,
    name,
    ui,
    onRejected,
    codec: codecName,
    lag,
    onBinary,
    onWelcome(message) {
      me = message.you;
      slot = null;
      // нова гра на сервері (перепідключення): стару історію й передбачення скидаємо
      buffer = new SnapshotBuffer();
      predictor = new Predictor({ ...SIZE, seed: message.match?.seed });
      predictor.enabled = mode !== 'dumb';
      predictor.onFired = onPredictedShot;
      events = [];
      lastSnapshotTick = null;
      latest = null;
    },
    onRoster(players) {
      slot = players.find((p) => p.id === me?.id)?.slot ?? slot;
    },
  });
  predictor.onFired = onPredictedShot;

  function onPredictedShot(pos: { x: number; y: number }): void {
    onEvent({ type: EVENT.FIRED, a: slot ?? NO_SLOT, b: 0, x: pos.x, y: pos.y, local: true });
  }

  // JSON-кодек: знімки й pong приходять текстом через диспетчер за type
  session.connection.on<SnapshotMessage>('snapshot', (message, size) => {
    const { type: _type, ...rest } = message;
    void _type;
    // JSON-шлях діагностичний: знімок уже перевірив сервер, лишається зняти обгортку
    onSnapshot(rest as unknown as Snapshot, size);
  });
  session.connection.on<PongMessage>('pong', (message) => onPong(message.t));

  const pingTimer = setInterval(() => {
    const t = now();
    const frame = codec.encodePing(Math.round(t) >>> 0);
    if (session.connection.sendGame(frame)) meters.bytesOut.add(frame.length, t);
  }, PING_EVERY_MS);

  // ------------------------------------------------------------ ввід (30 Гц)

  /** Один крок клієнта: зняти ввід, передбачити, відправити. */
  function step(intent: Intent): void {
    const input: ClientInput = {
      seq: toSeq(++seq),
      throttle: toAxis(intent.throttle),
      turn: toAxis(intent.turn),
      turretTurn: toAxis(intent.turretTurn),
      fire: Boolean(intent.fire),
    };

    predictor.step(input);
    predictor.stepBullets();

    recent.push(input);
    if (recent.length > INPUT_REDUNDANCY) recent.shift();
    const frame = codec.encodeInputs(recent);
    if (session.connection.sendGame(frame)) meters.bytesOut.add(frame.length, now());
  }

  // ------------------------------------------------------------ кадр

  /** Серверний час, який зараз малюємо (мс шкали тіків), або null. */
  function renderTime(t: number): number | null {
    const server = buffer.serverTime(t);
    return server === null ? null : server - delayMs;
  }

  function releaseEvents(t: number): void {
    const horizon = mode === 'full' ? renderTime(t) : Infinity;
    if (horizon === null) return;
    const ready = events.filter((e) => e.t <= horizon);
    events = events.filter((e) => e.t > horizon);

    for (const { event } of ready) {
      // власний постріл у режимах з передбаченням уже прозвучав локально
      if (event.type === EVENT.FIRED && event.a === slot && predictor.enabled) continue;
      if (event.type === EVENT.EXPLODED) effects.explode(event.x, event.y, event.b);
      onEvent(event);
    }
  }

  /** Сцена для рендера на цей кадр. alpha — частка між кроками клієнта. */
  function frame(alpha: number, dt: number): Scene | null {
    const t = now();
    predictor.smooth(dt);
    effects.update(dt);
    releaseEvents(t);

    if (!latest) return null;

    let world: Snapshot = latest;
    frameStarved = false;
    if (mode === 'full') {
      const rt = renderTime(t);
      const sample = rt === null ? null : buffer.sample(rt);
      if (sample) {
        world = interpolateSnapshot(sample.a, sample.b, sample.alpha, SIZE);
        frameStarved = sample.starved;
        if (frameStarved) counters.starved += 1;
      }
    }

    const predicted = predictor.enabled ? predictor.visual(alpha) : null;
    const authoritative = latest.ships.find((s) => s.slot === slot);

    const ships: SceneShip[] = [];
    for (const s of world.ships) {
      if (predicted && s.slot === slot) continue;
      ships.push(shipView(s, s.slot === slot));
    }
    if (predicted && authoritative) {
      ships.push(shipView({ ...authoritative, ...predicted, shield: predicted.effects.shield }, true));
    }

    const bullets: SceneBullet[] = [];
    const localTags = new Set(predictor.bullets.map((b) => b.seq & 0xffff));
    for (const b of world.bullets) {
      const mine = b.owner === slot;
      if (predictor.enabled && mine && localTags.has(b.tag)) continue; // показуємо передбачену
      bullets.push({ ...b, angle: Math.atan2(b.vy, b.vx), mine });
    }
    if (predictor.enabled) {
      for (const b of predictor.bullets) {
        const wrapped = Math.abs(b.x - b.px) > SIZE.width / 2 || Math.abs(b.y - b.py) > SIZE.height / 2;
        bullets.push({
          id: `local-${b.seq}`,
          x: wrapped ? b.x : b.px + (b.x - b.px) * alpha,
          y: wrapped ? b.y : b.py + (b.y - b.py) * alpha,
          angle: Math.atan2(b.vy, b.vx),
          homing: false,
          mine: true,
        });
      }
    }

    const score = latest.players.find((p) => p.slot === slot)?.score ?? 0;
    return {
      tick: latest.tick,
      ships,
      bullets,
      asteroids: world.asteroids,
      pickups: world.pickups,
      explosions: effects.explosions,
      me: authoritative
        ? {
            hp: authoritative.hp,
            maxHp: MAX_HP.player,
            score,
            shield: authoritative.shield,
            rapid: authoritative.rapid,
            homing: authoritative.homing,
          }
        : { dead: true, score },
    };
  }

  function shipView(s: SnapshotShip, isMe: boolean): SceneShip {
    return { ...s, isMe, maxHp: s.slot === NO_SLOT ? MAX_HP.enemy : MAX_HP.player };
  }

  // ------------------------------------------------------------ статистика

  function stats(): NetStats {
    const t = now();
    return {
      mode,
      codec: codecName,
      state: session.connection.state,
      slot,
      tick: latest?.tick ?? 0,
      rtt: meters.rtt.last,
      rttAvg: meters.rtt.value,
      snapshotAge: lastArrival === null ? null : t - lastArrival,
      snapshotInterval: meters.interval.value,
      snapshotsPerSec: meters.snapshots.perSecond(t),
      bytesIn: meters.bytesIn.perSecond(t),
      bytesOut: meters.bytesOut.perSecond(t),
      inputQueue: predictor.pending.length,
      correction: predictor.enabled ? predictor.lastCorrection : 0,
      correctionMax: meters.correction.max(t),
      delay: mode === 'full' ? delayMs : 0,
      delaySetting: delayMs,
      missed: counters.missed,
      starved: counters.starved,
      starvedNow: frameStarved,
      badFrames: counters.badFrames,
      buffered: buffer.size,
      lag: lag.config,
      lagStats: { ...lag.stats },
    };
  }

  return {
    step,
    frame,
    stats,
    lag,
    session,
    get mode(): Mode {
      return mode;
    },
    setMode(next: string): void {
      if (!isMode(next)) return;
      mode = next;
      predictor.enabled = next !== 'dumb';
      void MODES; // режими валідуються через isMode
    },
    get delayMs(): number {
      return delayMs;
    },
    setDelay(ms: number | string): void {
      delayMs = Math.min(1000, Math.max(0, Number(ms) || 0));
    },
    get slot(): number | null {
      return slot;
    },
    get predictor(): Predictor {
      return predictor;
    },
    get buffer(): SnapshotBuffer {
      return buffer;
    },
    sendChat: (text: string) => session.sendChat(text),
    leave(): void {
      clearInterval(pingTimer);
      lag.clear();
      session.leave();
    },
  };
}
