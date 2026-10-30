/** Чи друкує гравець у полі вводу (чат, ім'я): тоді клавіші не належать грі. */
export function isTyping(event) {
  const tag = event.target?.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    event.target?.isContentEditable === true
  );
}

export function createInput(target) {
  const down = new Set();

  function onKeyDown(event) {
    // Z/X/стрілки в чаті — це літери, а не повороти башти
    if (isTyping(event)) return;
    down.add(event.code);
  }

  // keyup обробляємо завжди: клавіша, відпущена вже в полі вводу, не повинна "залипнути"
  function onKeyUp(event) {
    down.delete(event.code);
  }

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  return {
    isDown(code) {
      return down.has(code);
    },
    /** Скинути всі натиснуті клавіші (наприклад, коли фокус пішов у чат). */
    clear() {
      down.clear();
    },
  };
}
