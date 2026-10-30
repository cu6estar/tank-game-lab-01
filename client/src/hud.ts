/**
 * HUD: FPS-лічильники з лаби 1 + рахунок, HP та ефекти гравця.
 *
 * Модуль живе поза симуляцією. Рахунок він отримує подією 'scoreChanged' від
 * Game, а HP та активні ефекти читає раз на кадр (вони змінюються постійно, і
 * подія на кожну зміну не окупилась би).
 */

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
    /** Рахунок приходить у знімку сервера (він єдиний, хто знає, хто кого вбив). */
    setScore(score) {
      setText('score', score);
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

    /** Раз на кадр: HP та ефекти нашого корабля (поле `me` сцени). */
    update(me) {
      if (!me || me.dead) {
        setText('hp', 'знищено — чекаємо респаун');
        setText('effects', '—');
        return;
      }

      setText('hp', `${me.hp} / ${me.maxHp}`);

      const active = [];
      for (const [key, label] of [
        ['shield', 'щит'],
        ['rapid', 'rapid fire'],
        ['homing', 'homing'],
      ]) {
        if (me[key] > 0) active.push(`${label} ${me[key].toFixed(1)} с`);
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
