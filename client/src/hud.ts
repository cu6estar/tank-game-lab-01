import type { SceneMe } from './net/scene.ts';

/**
 * HUD: FPS-лічильники з лаби 1 + рахунок, HP та ефекти гравця. Модуль живе поза
 * симуляцією: рахунок і HP приходять зі знімка сервера (поле `me` сцени).
 */
type HudNodeName = 'fps' | 'steps' | 'frame' | 'score' | 'hp' | 'effects' | 'sound' | 'pilot';

export interface Hud {
  setScore(score: number): void;
  recordStep(): void;
  recordFrame(frameTimeMs: number): void;
  update(me: SceneMe | null): void;
  setPilot(text: string): void;
  setSound(text: string): void;
}

export function createHud(root: ParentNode = document): Hud {
  const el = (id: HudNodeName): HTMLElement | null => root.querySelector<HTMLElement>(`#${id}`);
  const nodes: Record<HudNodeName, HTMLElement | null> = {
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
  const shown = new Map<HudNodeName, string>();
  function setText(name: HudNodeName, value: string | number): void {
    const text = String(value);
    if (shown.get(name) === text) return;
    shown.set(name, text);
    const node = nodes[name];
    if (node) node.textContent = text;
  }

  let stepsThisSecond = 0;
  let framesThisSecond = 0;
  let statsTimer = 0;

  return {
    setScore(score: number): void {
      setText('score', score);
    },

    recordStep(): void {
      stepsThisSecond += 1;
    },

    recordFrame(frameTimeMs: number): void {
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

    update(me: SceneMe | null): void {
      if (!me || me.dead) {
        setText('hp', 'знищено — чекаємо респаун');
        setText('effects', '—');
        return;
      }

      setText('hp', `${me.hp ?? 0} / ${me.maxHp ?? 0}`);

      const active: string[] = [];
      const effects: [keyof Pick<SceneMe, 'shield' | 'rapid' | 'homing'>, string][] = [
        ['shield', 'щит'],
        ['rapid', 'rapid fire'],
        ['homing', 'homing'],
      ];
      for (const [key, label] of effects) {
        const value = me[key] ?? 0;
        if (value > 0) active.push(`${label} ${value.toFixed(1)} с`);
      }
      setText('effects', active.length > 0 ? active.join(', ') : '—');
    },

    setPilot(text: string): void {
      setText('pilot', text);
    },

    setSound(text: string): void {
      setText('sound', text);
    },
  };
}
