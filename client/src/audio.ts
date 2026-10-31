/**
 * Звук на Web Audio API. Модуль володіє ЄДИНИМ AudioContext (створеним
 * "suspended", розблоковується першим жестом). Симуляцію не знає:
 * `playEvent(event)` отримує події зі знімків сервера.
 */
import { EVENT, KIND_CODE, NO_SLOT } from '@tank/shared/protocol/constants.ts';
import type { SceneEvent } from './net/scene.ts';

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

export interface PlayOptions {
  volume?: number;
  rate?: number;
  jitter?: number;
}

export interface AudioApi {
  readonly context: AudioContext;
  setBuffers(decoded: Record<string, AudioBuffer | null | undefined>): void;
  play(name: string, options?: PlayOptions): boolean;
  playEvent(event: SceneEvent): boolean;
  unlockOnGesture(target?: EventTarget): void;
  setMuted(value: boolean): void;
  toggleMute(): boolean;
  readonly muted: boolean;
  readonly state: AudioContextState;
  readonly voices: number;
  readonly loaded: number;
}

export interface AudioOptions {
  AudioContextClass?: typeof AudioContext;
  maxVoices?: number;
}

export function createAudio({ AudioContextClass = globalThis.AudioContext, maxVoices = 16 }: AudioOptions = {}): AudioApi {
  const context = new AudioContextClass();

  const master = context.createGain();
  master.connect(context.destination);

  const buffers = new Map<string, AudioBuffer>();
  let muted = false;
  let activeVoices = 0;

  function setBuffers(decoded: Record<string, AudioBuffer | null | undefined>): void {
    for (const [name, buffer] of Object.entries(decoded)) {
      if (buffer) buffers.set(name, buffer);
    }
  }

  function play(name: string, { volume = 1, rate = 1, jitter = 0.06 }: PlayOptions = {}): boolean {
    const buffer = buffers.get(name);

    // поки контекст не розблоковано, звуки не накопичуємо
    if (!buffer || context.state !== 'running') return false;
    if (activeVoices >= maxVoices) return false;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);

    const gain = context.createGain();
    gain.gain.value = volume;

    source.connect(gain).connect(master);
    source.onended = (): void => {
      activeVoices -= 1;
      source.disconnect();
      gain.disconnect();
    };

    activeVoices += 1;
    source.start();
    return true;
  }

  /** Подія зі знімка сервера (або локальне передбачення пострілу) → звук. */
  function playEvent(event: SceneEvent): boolean {
    switch (event.type) {
      case EVENT.FIRED:
        return play('shoot', { volume: event.a === NO_SLOT ? 0.35 : 0.7 });
      case EVENT.HIT:
        return play('hit', { volume: event.b ? 0.25 : 0.6, rate: event.b ? 1.6 : 1 });
      case EVENT.EXPLODED:
        if (event.a === KIND_CODE.ship) return play('explosion', { volume: 0.9, rate: 0.95 });
        if (event.a === KIND_CODE.asteroid) return play('explosion', { volume: 0.55, rate: 1.15 });
        return false;
      default:
        return false;
    }
  }

  /** Розблокувати контекст першим жестом гравця (клік, клавіша, дотик). */
  function unlockOnGesture(target: EventTarget = globalThis): void {
    if (context.state === 'running') return;

    const controller = new AbortController();

    const unlock = async (): Promise<void> => {
      try {
        await context.resume();
      } catch {
        return; // не вийшло — спробуємо при наступному жесті
      }
      if (context.state === 'running') controller.abort();
    };

    for (const type of UNLOCK_EVENTS) {
      target.addEventListener(type, () => void unlock(), { signal: controller.signal });
    }
  }

  function setMuted(value: boolean): void {
    muted = Boolean(value);
    master.gain.value = muted ? 0 : 1;
  }

  return {
    context,
    setBuffers,
    play,
    playEvent,
    unlockOnGesture,
    setMuted,
    toggleMute(): boolean {
      setMuted(!muted);
      return muted;
    },
    get muted(): boolean {
      return muted;
    },
    get state(): AudioContextState {
      return context.state;
    },
    get voices(): number {
      return activeVoices;
    },
    get loaded(): number {
      return buffers.size;
    },
  };
}
