import { DT } from '@tank/shared/constants.ts';

// Крок клієнта = крок сервера (30 Гц): один ввід на один крок симуляції.
const STEP = DT;
const MAX_FRAME_TIME = 0.25;

export interface LoopHandlers {
  step(dt: number): void;
  render(alpha: number, frameTimeMs: number): void;
}

export interface Loop {
  start(): void;
  stop(): void;
}

export function createLoop({ step, render }: LoopHandlers): Loop {
  let running = false;
  let accumulator = 0;
  let previousTime = 0;
  let animationFrameId = 0;

  function frame(currentTime: number): void {
    if (!running) return;

    const frameTime = Math.min((currentTime - previousTime) / 1000, MAX_FRAME_TIME);
    previousTime = currentTime;
    accumulator += frameTime;

    while (accumulator >= STEP) {
      step(STEP);
      accumulator -= STEP;
    }

    const alpha = accumulator / STEP;
    render(alpha, frameTime * 1000);

    animationFrameId = requestAnimationFrame(frame);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      previousTime = performance.now();
      animationFrameId = requestAnimationFrame(frame);
    },
    stop(): void {
      running = false;
      cancelAnimationFrame(animationFrameId);
    },
  };
}
