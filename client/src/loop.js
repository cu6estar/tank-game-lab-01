const STEP = 1 / 60;
const MAX_FRAME_TIME = 0.25;

export function createLoop({ step, render }) {
  let running = false;
  let accumulator = 0;
  let previousTime = 0;
  let animationFrameId = 0;

  function frame(currentTime) {
    if (!running) return;

    const frameTime = Math.min(
      (currentTime - previousTime) / 1000,
      MAX_FRAME_TIME,
    );

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
    start() {
      if (running) return;
      running = true;
      previousTime = performance.now();
      animationFrameId = requestAnimationFrame(frame);
    },

    stop() {
      running = false;
      cancelAnimationFrame(animationFrameId);
    },
  };
}
