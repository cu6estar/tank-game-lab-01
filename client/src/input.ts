/** Чи друкує гравець у полі вводу (чат, ім'я): тоді клавіші не належать грі. */
export function isTyping(event: Event): boolean {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export interface InputController {
  isDown(code: string): boolean;
  clear(): void;
}

export function createInput(target: Window = window): InputController {
  const down = new Set<string>();

  const onKeyDown = (event: KeyboardEvent): void => {
    // Z/X/стрілки в чаті — це літери, а не повороти башти
    if (isTyping(event)) return;
    down.add(event.code);
  };

  // keyup обробляємо завжди: клавіша, відпущена вже в полі вводу, не повинна "залипнути"
  const onKeyUp = (event: KeyboardEvent): void => {
    down.delete(event.code);
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);

  return {
    isDown(code: string): boolean {
      return down.has(code);
    },
    clear(): void {
      down.clear();
    },
  };
}
