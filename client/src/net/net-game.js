import { CodecError, getCodec, peekType } from '@tank/shared/codec/index.js';
import { ARENA_HEIGHT, ARENA_WIDTH, TICK_MS } from '@tank/shared/constants.js';
import {
  EVENT,
  INPUT_REDUNDANCY,
  MAX_HP,
  MSG,
  NO_SLOT,
} from '@tank/shared/protocol/constants.js';
import { createEffects } from '../fx.js';
import { interpolateSnapshot } from './interpolate.js';
import { createLagInjector } from './lag.js';
import { Predictor } from './predictor.js';
import { joinRoomSession } from './room-session.js';
import { SnapshotBuffer } from './snapshot-buffer.js';
import { RateMeter, Smoothed } from './stats.js';

/** Затримка інтерполяції за замовчуванням, мс (див. README: вибір значення). */
export const DEFAULT_INTERP_DELAY = 100;
const PING_EVERY_MS = 500;
const SIZE = { width: ARENA_WIDTH, height: ARENA_HEIGHT };

/**
 * Режими показу (кожен наступний додає один прийом):
 *   dumb    — M1: малюємо лише останній знімок, навіть власний корабель
 *   predict — M2: власний корабель рухається одразу (передбачення + звірка)
 *   full    — M3: + чужі об'єкти інтерполюються між двома знімками в минулому
 */
export const MODES = ['dumb', 'predict', 'full'];

/**
 * Мережева частина клієнта гри: з'єднання, кодек, ввід із seq, передбачення,
 * звірка, буфер інтерполяції, статистика для netgraph.
 */
export function createNetGame({
  roomId,
  name,
  ui,
  onRejected,
  onEvent = () => {},
  search = globalThis.location?.search ?? '',
  now = () => performance.now(),
}) {
  const params = new URLSearchParams(search);
  const codecName = params.get('codec') === 'json' ? 'json' : 'binary';
  const codec = getCodec(codecName);
  const lag = createLagInjector();
  lag.configureFromQuery(search);

  let mode = MODES.includes(params.get('mode')) ? params.get('mode') : 'full';
  let delayMs = Number(params.get('delay')) || DEFAULT_INTERP_DELAY;

  let me = null; // { id, name } з welcome
  let slot = null; // наш слот з roster
  let seq = 0;
  let predictor = new Predictor({ ...SIZE });
  let buffer = new SnapshotBuffer();
  const recent = []; // останні ввід для надлишковості
  const effects = createEffects();
  let events = []; // { t, event }: чекають моменту показу
  let lastSnapshotTick = null;
  let latest = null;

  const meters = {
    bytesIn: new RateMeter(),
    bytesOut: new RateMeter(),
    snapshots: new RateMeter(),
    rtt: new Smoothed({ alpha: 0.2 }),
    interval: new Smoothed({ alpha: 0.1 }),
    correction: new Smoothed({ alpha: 0.3 }),
  };
  const counters = { missed: 0, starved: 0, badFrames: 0 };
  let lastArrival = null;
  let frameStarved = false;

  predictor.enabled = mode !== 'dumb';

  // ------------------------------------------------------------ приймання

  function onSnapshot(snapshot, bytes) {
    const t = now();
    const result = buffer.push(snapshot, t);
    meters.bytesIn.add(bytes, t);
    if (result !== 'ok') return;

    meters.snapshots.add(1, t);
    if (lastArrival !== null) meters.interval.add(t - lastArrival, t);
    lastArrival = t;
    if (lastSnapshotTick !== null)
      counters.missed += Math.max(0, snapshot.tick - lastSnapshotTick - 1);
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

  function onBinary(frame) {
    try {
      switch (peekType(frame)) {
        case MSG.SNAPSHOT:
          return onSnapshot(codec.decodeSnapshot(frame), frame.byteLength);
        case MSG.PONG:
          return onPong(codec.decodePong(frame).echo);
        default:
          counters.badFrames += 1;
      }
    } catch (error) {
      if (!(error instanceof CodecError)) throw error;
      counters.badFrames += 1;
      console.warn('[net] битий кадр:', error.message);
    }
  }

  function onPong(echo) {
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

  function onPredictedShot(pos) {
    onEvent({
      type: EVENT.FIRED,
      a: slot ?? NO_SLOT,
      x: pos.x,
      y: pos.y,
      local: true,
    });
  }

  // JSON-кодек: знімки й pong приходять текстом через диспетчер за type
  session.connection.on('snapshot', (message, size) => {
    const { type, ...snapshot } = message;
    void type;
    onSnapshot(snapshot, size ?? 0);
  });
  session.connection.on('pong', (message) => onPong(message.t));

  const pingTimer = setInterval(() => {
    const t = now();
    const frame = codec.encodePing(Math.round(t) >>> 0);
    if (session.connection.sendGame(frame))
      meters.bytesOut.add(frame.length ?? frame.byteLength, t);
  }, PING_EVERY_MS);

  // ------------------------------------------------------------ ввід (30 Гц)

  /** Один крок клієнта: зняти ввід, передбачити, відправити. */
  function step(intent) {
    const input = {
      seq: ++seq,
      throttle: intent.throttle,
      turn: intent.turn,
      turretTurn: intent.turretTurn,
      fire: Boolean(intent.fire),
    };

    predictor.step(input);
    predictor.stepBullets();

    recent.push(input);
    if (recent.length > INPUT_REDUNDANCY) recent.shift();
    const frame = codec.encodeInputs(recent);
    if (session.connection.sendGame(frame))
      meters.bytesOut.add(frame.length ?? frame.byteLength, now());
  }

  // ------------------------------------------------------------ кадр

  /** Серверний час, який зараз малюємо (мс шкали тіків), або null. */
  function renderTime(t) {
    const server = buffer.serverTime(t);
    return server === null ? null : server - delayMs;
  }

  function releaseEvents(t) {
    const horizon = mode === 'full' ? renderTime(t) : Infinity;
    if (horizon === null) return;
    const ready = events.filter((e) => e.t <= horizon);
    events = events.filter((e) => e.t > horizon);

    for (const { event } of ready) {
      // власний постріл у режимах з передбаченням уже прозвучав локально
      if (event.type === EVENT.FIRED && event.a === slot && predictor.enabled)
        continue;
      if (event.type === EVENT.EXPLODED)
        effects.explode(event.x, event.y, event.b);
      onEvent(event);
    }
  }

  /** Сцена для рендера на цей кадр. alpha — частка між кроками клієнта (для передбаченого корабля). */
  function frame(alpha, dt) {
    const t = now();
    predictor.smooth(dt);
    effects.update(dt);
    releaseEvents(t);

    if (!latest) return null;

    let world = latest;
    frameStarved = false;
    if (mode === 'full') {
      const sample = buffer.sample(renderTime(t));
      if (sample) {
        world = interpolateSnapshot(sample.a, sample.b, sample.alpha, SIZE);
        frameStarved = sample.starved;
        if (frameStarved) counters.starved += 1;
      }
    }

    const predicted = predictor.enabled ? predictor.visual(alpha) : null;
    const authoritative = latest.ships.find((s) => s.slot === slot);

    const ships = [];
    for (const s of world.ships) {
      if (predicted && s.slot === slot) continue;
      ships.push(shipView(s, s.slot === slot));
    }
    if (predicted && authoritative) {
      ships.push(
        shipView(
          { ...authoritative, ...predicted, shield: predicted.effects.shield },
          true,
        ),
      );
    }

    const bullets = [];
    const localTags = new Set(predictor.bullets.map((b) => b.seq & 0xffff));
    for (const b of world.bullets) {
      const mine = b.owner === slot;
      if (predictor.enabled && mine && localTags.has(b.tag)) continue; // показуємо передбачену
      bullets.push({ ...b, angle: Math.atan2(b.vy, b.vx), mine });
    }
    if (predictor.enabled) {
      for (const b of predictor.bullets) {
        const wrapped =
          Math.abs(b.x - b.px) > SIZE.width / 2 ||
          Math.abs(b.y - b.py) > SIZE.height / 2;
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
            score: latest.players.find((p) => p.slot === slot)?.score ?? 0,
            shield: authoritative.shield,
            rapid: authoritative.rapid,
            homing: authoritative.homing,
          }
        : {
            dead: true,
            score: latest.players.find((p) => p.slot === slot)?.score ?? 0,
          },
    };
  }

  function shipView(s, isMe) {
    return {
      ...s,
      isMe,
      maxHp: s.slot === NO_SLOT ? MAX_HP.enemy : MAX_HP.player,
    };
  }

  // ------------------------------------------------------------ статистика

  function stats() {
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
    get mode() {
      return mode;
    },
    setMode(next) {
      if (!MODES.includes(next)) return;
      mode = next;
      predictor.enabled = next !== 'dumb';
    },
    get delayMs() {
      return delayMs;
    },
    setDelay(ms) {
      delayMs = Math.min(1000, Math.max(0, Number(ms) || 0));
    },
    get slot() {
      return slot;
    },
    get predictor() {
      return predictor;
    },
    get buffer() {
      return buffer;
    },
    sendChat: (text) => session.sendChat(text),
    leave() {
      clearInterval(pingTimer);
      lag.clear();
      session.leave();
    },
  };
}
