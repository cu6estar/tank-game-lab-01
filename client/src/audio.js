/**
 * Звук на Web Audio API.
 *
 * Модуль володіє ЄДИНИМ AudioContext. Браузер не дозволяє звуку стартувати без
 * жесту гравця, тому контекст створюється "suspended", а `resume()` викликається
 * з першого кліку/натискання (див. unlockOnGesture). Буфери при цьому
 * декодуються ще на екрані завантаження — `loadAudio(context, ...)` потребує
 * контекст, а не дозволу грати.
 *
 * Симуляцію модуль не знає: `playEvent(event)` отримує події зі знімків сервера.
 */

import { EVENT, KIND_CODE, NO_SLOT } from '@tank/shared/protocol/constants.js';

const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'];

export function createAudio({
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  maxVoices = 16,
} = {}) {
  const context = new AudioContextClass();

  const master = context.createGain();
  master.connect(context.destination);

  const buffers = new Map();
  let muted = false;
  let activeVoices = 0;

  function setBuffers(decoded) {
    for (const [name, buffer] of Object.entries(decoded)) {
      if (buffer) buffers.set(name, buffer);
    }
  }

  /**
   * Одноразовий AudioBufferSourceNode на кожне відтворення: вони дешеві, а
   * один і той самий AudioBuffer можна грати скільки завгодно разів поспіль,
   * накладаючи постріли один на одного (на відміну від <audio>).
   */
  function play(name, { volume = 1, rate = 1, jitter = 0.06 } = {}) {
    const buffer = buffers.get(name);

    // поки контекст не розблоковано, звуки не накопичуємо: інакше після
    // першого кліку вибухнула б черга з усього, що відбулося раніше
    if (!buffer || context.state !== 'running') return false;
    if (activeVoices >= maxVoices) return false;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);

    const gain = context.createGain();
    gain.gain.value = volume;

    source.connect(gain).connect(master);
    source.onended = () => {
      activeVoices -= 1;
      source.disconnect();
      gain.disconnect();
    };

    activeVoices += 1;
    source.start();
    return true;
  }

  /**
   * Подія зі знімка сервера (або локальне передбачення пострілу) → звук.
   * Клієнт не симулює влучання, тож про звук дізнається так само, як про
   * картинку: від сервера. Типи — shared/protocol/constants.js (EVENT, KIND_CODE).
   */
  function playEvent(event) {
    switch (event.type) {
      case EVENT.FIRED:
        return play('shoot', { volume: event.a === NO_SLOT ? 0.35 : 0.7 });
      case EVENT.HIT:
        return play('hit', {
          volume: event.b ? 0.25 : 0.6,
          rate: event.b ? 1.6 : 1,
        });
      case EVENT.EXPLODED:
        if (event.a === KIND_CODE.ship)
          return play('explosion', { volume: 0.9, rate: 0.95 });
        if (event.a === KIND_CODE.asteroid)
          return play('explosion', { volume: 0.55, rate: 1.15 });
        return false;
      default:
        return false;
    }
  }

  /** Розблокувати контекст першим жестом гравця (клік, клавіша, дотик). */
  function unlockOnGesture(target = globalThis) {
    if (context.state === 'running') return;

    const controller = new AbortController();

    const unlock = async () => {
      try {
        await context.resume();
      } catch {
        return; // не вийшло — спробуємо при наступному жесті
      }
      if (context.state === 'running') controller.abort();
    };

    for (const type of UNLOCK_EVENTS) {
      target.addEventListener(type, unlock, { signal: controller.signal });
    }
  }

  function setMuted(value) {
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
    toggleMute() {
      setMuted(!muted);
      return muted;
    },
    get muted() {
      return muted;
    },
    get state() {
      return context.state;
    },
    get voices() {
      return activeVoices;
    },
    /** Скільки звуків реально завантажено (0, якщо файли не прийшли). */
    get loaded() {
      return buffers.size;
    },
  };
}
