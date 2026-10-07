import './style.css';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createRenderer } from './render.js';
import { Game } from './sim/game.js';

const canvas = document.querySelector('#gameCanvas');
const fpsElement = document.querySelector('#fps');
const stepsElement = document.querySelector('#steps');
const frameElement = document.querySelector('#frame');
const scoreElement = document.querySelector('#score');
const hpElement = document.querySelector('#hp');
const effectsElement = document.querySelector('#effects');

const EFFECT_LABELS = {
  shield: 'щит',
  rapidFire: 'rapid fire',
  homingShots: 'homing',
};

const input = createInput(window);
const renderer = createRenderer(canvas);
const game = new Game({ width: renderer.width, height: renderer.height });
game.start();

/*
 * Постріл через слухач клавіатури.
 *
 * НАЇВНО (баг): window.addEventListener('keydown', ship.fire);
 *   Браузер викликає слухача з this = window, а не кораблем, тому
 *   всередині fire() `this.cooldown`, `this.pos`... читаються з window
 *   і все ламається (TypeError).
 *
 * ФІКС: стрілка-обгортка. Метод викликається як `game.player.fire()` —
 * implicit binding, this = корабель. Обгортка ще й бере ПОТОЧНОГО гравця
 * на момент натискання (після респауну це вже новий корабель).
 * Альтернативи (.bind, поле-стрілка) описані в README.
 */
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;

  event.preventDefault();
  game.player?.fire();
});

let stepsThisSecond = 0;
let fpsThisSecond = 0;
let statsTimer = 0;

function updateGameHud() {
  scoreElement.textContent = String(game.score);

  const player = game.player;

  if (!player) {
    const seconds = game.respawnIn ?? 0;
    hpElement.textContent = `знищено — респаун через ${seconds.toFixed(1)} с`;
    effectsElement.textContent = '—';
    return;
  }

  hpElement.textContent = `${player.hp} / ${player.maxHp}`;

  const active = [];
  for (const [name, component] of player.eachComponent()) {
    if (component.remaining === undefined) continue;
    active.push(
      `${EFFECT_LABELS[name] ?? name} ${Math.max(0, component.remaining).toFixed(1)} с`,
    );
  }
  effectsElement.textContent = active.length > 0 ? active.join(', ') : '—';
}

const loop = createLoop({
  step(dt) {
    game.resize(renderer.width, renderer.height);
    game.step(dt, input);
    stepsThisSecond += 1;
  },

  render(alpha, frameTime) {
    renderer.draw(game.world, alpha);
    updateGameHud();

    fpsThisSecond += 1;
    statsTimer += frameTime;

    if (statsTimer >= 1000) {
      fpsElement.textContent = String(fpsThisSecond);
      stepsElement.textContent = String(stepsThisSecond);
      frameElement.textContent = frameTime.toFixed(2);

      fpsThisSecond = 0;
      stepsThisSecond = 0;
      statsTimer = 0;
    }
  },
});

loop.start();
