/**
 * Звук на Web Audio API.
 *
 * Модуль володіє ЄДИНИМ AudioContext. Браузер не дозволяє звуку стартувати без
 * жесту гравця, тому контекст створюється "suspended", а `resume()` викликається
 * з першого кліку/натискання (див. unlockOnGesture). Буфери при цьому
 * декодуються ще на екрані завантаження — `loadAudio(context, ...)` потребує
 * контекст, а не дозволу грати.
 *
 * З симуляцією модуль не зв'язаний імпортами: `bind(world)` лише підписується на
 * події 'fired' / 'hit' / 'exploded'. Світ про звук нічого не знає.
 */

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
   * Підписка на події світу. Усі слухачі — стрілки, тому `play` не залежить
   * від `this`. `signal` дозволяє зняти всі слухачі одним abort()-ом, коли
   * гру закрито (див. main.js).
   */
  function bind(world, { signal } = {}) {
    const on = (type, handler) =>
      world.addEventListener(type, handler, { signal });

    on('fired', (event) =>
      play('shoot', { volume: event.detail.team === 'player' ? 0.7 : 0.35 }),
    );

    on('hit', (event) =>
      play('hit', {
        volume: event.detail.blocked ? 0.25 : 0.6,
        rate: event.detail.blocked ? 1.6 : 1,
      }),
    );

    on('exploded', (event) => {
      const { kind } = event.detail;
      if (kind !== 'ship' && kind !== 'asteroid') return;

      play('explosion', {
        volume: kind === 'ship' ? 0.9 : 0.55,
        rate: kind === 'ship' ? 0.95 : 1.15,
      });
    });
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
    bind,
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
