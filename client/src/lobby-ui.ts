import { describeError } from './describe-error.ts';
import type { Lobby, LobbyRoom } from './lobby.ts';

const NAME_KEY = 'tank-arena:name';

export interface LobbyUi {
  show(options?: { notice?: string | null }): void;
  hide(): void;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`lobby-ui: не знайдено ${selector}`);
  return el;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** DOM лобі. Слухає події Lobby ('loading', 'roomsChanged', 'error') і малює. */
export function createLobbyUi(root: HTMLElement, lobby: Lobby): LobbyUi {
  const form = required<HTMLFormElement>(root, '#lobby-form');
  const nameInput = required<HTMLInputElement>(root, '#player-name');
  const list = required<HTMLElement>(root, '#room-list');
  const status = required<HTMLElement>(root, '#lobby-status');
  const retryButton = required<HTMLButtonElement>(root, '#lobby-retry');
  const joinButton = required<HTMLButtonElement>(root, '#join');
  const notice = required<HTMLElement>(root, '#lobby-notice');

  let selectedId: string | null = null;
  let listeners: AbortController | null = null;

  nameInput.value = readSavedName();

  function readSavedName(): string {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return ''; // приватний режим / заблоковане сховище — не критично
    }
  }

  function saveName(value: string): void {
    try {
      localStorage.setItem(NAME_KEY, value);
    } catch {
      // нічого: ім'я просто не запам'ятається
    }
  }

  function setStatus(text: string, { error = false, retry = false }: { error?: boolean; retry?: boolean } = {}): void {
    status.textContent = text;
    status.classList.toggle('error', error);
    retryButton.hidden = !retry;
  }

  function renderRooms(rooms: LobbyRoom[]): void {
    list.replaceChildren();

    if (rooms.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Кімнат поки немає';
      list.append(empty);
    }

    const stillValid = rooms.some((room) => room.id === selectedId && room.players < room.maxPlayers);
    if (!stillValid) selectedId = null;

    for (const room of rooms) {
      const full = room.players >= room.maxPlayers;

      const item = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'room';
      label.classList.toggle('full', full);

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'room';
      radio.value = room.id;
      radio.disabled = full;
      radio.checked = room.id === selectedId;
      radio.addEventListener('change', () => {
        selectedId = room.id;
        updateJoinState();
      });

      const title = document.createElement('span');
      title.className = 'room-name';
      title.textContent = room.name;

      const meta = document.createElement('span');
      meta.className = 'room-meta';
      const enemies = room.arena['enemies'];
      const asteroids = room.arena['asteroids'];
      meta.textContent =
        `${room.players}/${room.maxPlayers} гравців` +
        (enemies !== undefined ? ` · ворогів ${enemies}` : '') +
        (asteroids !== undefined ? ` · астероїдів ${asteroids}` : '') +
        (full ? ' · заповнена' : '');

      label.append(radio, title, meta);
      item.append(label);
      list.append(item);
    }

    updateJoinState();
  }

  function updateJoinState(): void {
    joinButton.disabled = selectedId === null;
  }

  function setNotice(text: string | null | undefined): void {
    notice.textContent = text ?? '';
    notice.hidden = !text;
  }

  function onSubmit(event: Event): void {
    event.preventDefault();
    if (selectedId === null) return;
    setNotice(null);

    lobby.playerName = nameInput.value;
    saveName(nameInput.value.trim());

    try {
      lobby.join(selectedId);
    } catch (error: unknown) {
      setStatus(errorMessage(error), { error: true });
    }
  }

  return {
    show({ notice: text }: { notice?: string | null } = {}): void {
      root.hidden = false;
      setNotice(text);
      listeners?.abort();
      listeners = new AbortController();
      const { signal } = listeners;

      lobby.addEventListener(
        'loading',
        () => {
          if (lobby.rooms.length === 0) setStatus('Завантаження кімнат…');
        },
        { signal },
      );

      lobby.addEventListener(
        'roomsChanged',
        (event) => {
          renderRooms(event.detail);
          setStatus(`Оновлено о ${new Date().toLocaleTimeString('uk-UA')}`);
        },
        { signal },
      );

      lobby.addEventListener(
        'error',
        (event) => {
          const { title, detail } = describeError(event.detail);
          setStatus(`Не вдалося оновити список кімнат: ${title}. ${detail}`, { error: true, retry: true });
        },
        { signal },
      );

      form.addEventListener('submit', onSubmit, { signal });
      retryButton.addEventListener('click', () => void lobby.refresh(), { signal });

      document.addEventListener('visibilitychange', () => (document.hidden ? lobby.stop() : lobby.start()), { signal });

      renderRooms(lobby.rooms);
      setStatus('Завантаження кімнат…');
      lobby.start();
      nameInput.focus();
    },

    hide(): void {
      root.hidden = true;
      listeners?.abort();
      listeners = null;
      lobby.stop();
    },
  };
}
