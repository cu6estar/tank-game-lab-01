export function createInput(target) {
  const down = new Set();

  function onKeyDown(event) {
    down.add(event.code);
  }

  function onKeyUp(event) {
    down.delete(event.code);
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  return {
    isDown(code) {
      return down.has(code);
    },
  };
}
