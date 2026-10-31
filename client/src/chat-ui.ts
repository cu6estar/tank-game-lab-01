import type { ChatMessage, RosterMessage } from './net/messages.ts';
import type { RoomUi } from './net/room-session.ts';

const MAX_LINES = 100;

export interface ChatUi extends RoomUi {
  readonly input: HTMLInputElement;
  reset(): void;
  onSubmit(handler: (text: string) => void, options?: { signal?: AbortSignal }): void;
  focus(): void;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`chat-ui: не знайдено ${selector}`);
  return el;
}

/**
 * DOM чату й списку гравців. Нічого не знає про мережу: main передає сюди те, що
 * прийшло з сервера. Дані — лише через textContent (без innerHTML), тож ім'я
 * "<img onerror=…>" залишиться просто текстом.
 */
export function createChatUi(root: ParentNode = document): ChatUi {
  const status = required<HTMLElement>(root, '#net-status');
  const rosterEl = required<HTMLElement>(root, '#roster');
  const log = required<HTMLElement>(root, '#chat-log');
  const form = required<HTMLFormElement>(root, '#chat-form');
  const input = required<HTMLInputElement>(root, '#chat-input');

  function append(item: Node): void {
    // чат прокручуємо вниз, лише якщо гравець і так дивиться в кінець
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.append(item);
    while (log.children.length > MAX_LINES) log.firstElementChild?.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  return {
    input,

    reset(): void {
      log.replaceChildren();
      rosterEl.textContent = '';
      input.value = '';
      status.textContent = '—';
      status.dataset['state'] = '';
    },

    setStatus(state: string, text: string): void {
      status.dataset['state'] = state;
      status.textContent = text;
    },

    setRoster(players: RosterMessage['players'], myId?: string): void {
      rosterEl.textContent =
        `Гравці (${players.length}): ` +
        players.map((p) => (p.id === myId ? `${p.name} (ви)` : p.name)).join(', ');
    },

    addChat(message: ChatMessage, myId?: string): void {
      const { from, text, t } = message;
      const item = document.createElement('li');
      if (from.id === myId) item.className = 'mine';

      const time = new Date(t).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = from.name;
      item.append(`${time} `, who, `: ${text}`);
      append(item);
    },

    addSystem(text: string): void {
      const item = document.createElement('li');
      item.className = 'system';
      item.textContent = text;
      append(item);
    },

    onSubmit(handler: (text: string) => void, { signal }: { signal?: AbortSignal } = {}): void {
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

    focus(): void {
      input.focus();
    },
  };
}
