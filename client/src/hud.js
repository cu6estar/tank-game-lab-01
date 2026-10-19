/**
 * HUD: FPS-лічильники з лаби 1 + рахунок, HP та ефекти гравця.
 *
 * Модуль живе поза симуляцією. Рахунок він отримує подією 'scoreChanged' від
 * Game, а HP та активні ефекти читає раз на кадр (вони змінюються постійно, і
 * подія на кожну зміну не окупилась би).
 */

const EFFECT_LABELS = {
  shield: 'щит',
  rapidFire: 'rapid fire',
  homingShots: 'homing',
};

export function createHud(root = document) {
  const el = (id) => root.querySelector(`#${id}`);
  const nodes = {
    fps: el('fps'),
    steps: el('steps'),
    frame: el('frame'),
    score: el('score'),
    hp: el('hp'),
    effects: el('effects'),
    sound: el('sound'),
    pilot: el('pilot'),
  };

  // записуємо в DOM лише коли текст справді змінився
  const shown = new Map();
  function setText(name, value) {
    const text = String(value);
    if (shown.get(name) === text) return;
    shown.set(name, text);
    nodes[name].textContent = text;
  }

  let stepsThisSecond = 0;
  let framesThisSecond = 0;
  let statsTimer = 0;

  return {
    /** Підписатися на рахунок гри; `signal` знімає слухача при виході в лобі. */
    bindGame(game, { signal } = {}) {
      setText('score', game.score);
      game.addEventListener(
        'scoreChanged',
        (event) => setText('score', event.detail.score),
        { signal },
      );
    },

    recordStep() {
      stepsThisSecond += 1;
    },

    recordFrame(frameTimeMs) {
      framesThisSecond += 1;
      statsTimer += frameTimeMs;
      if (statsTimer < 1000) return;

      setText('fps', framesThisSecond);
      setText('steps', stepsThisSecond);
      setText('frame', frameTimeMs.toFixed(2));

      framesThisSecond = 0;
      stepsThisSecond = 0;
      statsTimer = 0;
    },

    /** Раз на кадр: HP, ефекти, відлік до респауну. */
    update(game) {
      const player = game.player;

      if (!player) {
        const seconds = game.respawnIn ?? 0;
        setText('hp', `знищено — респаун через ${seconds.toFixed(1)} с`);
        setText('effects', '—');
        return;
      }

      setText('hp', `${player.hp} / ${player.maxHp}`);

      const active = [];
      for (const [name, component] of player.eachComponent()) {
        if (component.remaining === undefined) continue;
        const left = Math.max(0, component.remaining).toFixed(1);
        active.push(`${EFFECT_LABELS[name] ?? name} ${left} с`);
      }
      setText('effects', active.length > 0 ? active.join(', ') : '—');
    },

    /** Ім'я пілота та кімната, до якої він приєднався. */
    setPilot(text) {
      setText('pilot', text);
    },

    /** Стан звуку: очікує жесту / працює / вимкнено (M). */
    setSound(text) {
      setText('sound', text);
    },
  };
}
