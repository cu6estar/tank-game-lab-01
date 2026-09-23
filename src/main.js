import './style.css';
import { createInput } from './input.js';
import { createLoop } from './loop.js';
import { createTank, integrateTank } from './sim/tank.js';
import { createRenderer } from './render.js';

const canvas = document.querySelector('#gameCanvas');
const fpsElement = document.querySelector('#fps');
const stepsElement = document.querySelector('#steps');
const frameElement = document.querySelector('#frame');

const input = createInput(window);
const renderer = createRenderer(canvas);
const tank = createTank(renderer.width / 2, renderer.height / 2);

let stepsThisSecond = 0;
let fpsThisSecond = 0;
let statsTimer = 0;

const loop = createLoop({
  step(dt) {
    integrateTank(tank, input, dt, renderer.width, renderer.height);
    stepsThisSecond += 1;
  },

  render(alpha, frameTime) {
    renderer.draw(tank, alpha);

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
