const MAX_LINES = 100;

/**
 * DOM чату й списку гравців. Нічого не знає про мережу: main.js передає сюди
 * те, що прийшло з сервера. Дані — лише через textContent (без innerHTML),
 * тож ім'я "<img onerror=…>" залишиться просто текстом.
 */
export function createChatUi(root = document) {
  const status = root.querySelector('#net-status');
  const rosterEl = root.querySelector('#roster');
  const log = root.querySelector('#chat-log');
  const form = root.querySelector('#chat-form');
  const input = root.querySelector('#chat-input');

  function append(item) {
    // чат прокручуємо вниз, лише якщо гравець і так дивиться в кінець
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.append(item);
    while (log.children.length > MAX_LINES) log.firstElementChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  return {
    input,

    reset() {
      log.replaceChildren();
      rosterEl.textContent = '';
      input.value = '';
      status.textContent = '—';
      status.dataset.state = '';
    },

    setStatus(state, text) {
      status.dataset.state = state;
      status.textContent = text;
    },

    setRoster(players, myId) {
      rosterEl.textContent =
        `Гравці (${players.length}): ` +
        players
          .map((p) => (p.id === myId ? `${p.name} (ви)` : p.name))
          .join(', ');
    },

    addChat({ from, text, t }, myId) {
      const item = document.createElement('li');
      if (from.id === myId) item.className = 'mine';

      const time = new Date(t).toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${from.name}`;
      item.append(`${time} `, who, `: ${text}`);
      append(item);
    },

    addSystem(text) {
      const item = document.createElement('li');
      item.className = 'system';
      item.textContent = text;
      append(item);
    },

    /** Відправка з форми: handler(text) отримує очищений непорожній текст. */
    onSubmit(handler, { signal } = {}) {
      form.addEventListener(
        'submit',
        (event) => {
          event.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          input.value = '';
          handler(text);
        },
        { signal },
      );
    },

    focus() {
      input.focus();
    },
  };
}
