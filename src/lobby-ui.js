import { describeError } from './describe-error.js';

const NAME_KEY = 'tank-arena:name';

/**
 * DOM лобі. Нічого не знає про fetch: слухає події Lobby ('loading',
 * 'roomsChanged', 'error') і малює; на кліки відповідає викликом lobby.join().
 *
 * Дані з сервера потрапляють у DOM лише через textContent — без innerHTML,
 * тому назва кімнати на кшталт "<img onerror=…>" залишиться просто текстом.
 */
export function createLobbyUi(root, lobby) {
  const form = root.querySelector('#lobby-form');
  const nameInput = root.querySelector('#player-name');
  const list = root.querySelector('#room-list');
  const status = root.querySelector('#lobby-status');
  const retryButton = root.querySelector('#lobby-retry');
  const joinButton = root.querySelector('#join');

  let selectedId = null;
  let listeners = null; // AbortController слухачів, поки лобі видиме

  nameInput.value = readSavedName();

  function readSavedName() {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return ''; // приватний режим / заблоковане сховище — не критично
    }
  }

  function saveName(value) {
    try {
      localStorage.setItem(NAME_KEY, value);
    } catch {
      // нічого: ім'я просто не запам'ятається
    }
  }

  function setStatus(text, { error = false, retry = false } = {}) {
    status.textContent = text;
    status.classList.toggle('error', error);
    retryButton.hidden = !retry;
  }

  function renderRooms(rooms) {
    list.replaceChildren();

    if (rooms.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Кімнат поки немає';
      list.append(empty);
    }

    // вибір переживає оновлення, поки кімната існує і не заповнилась
    const stillValid = rooms.some(
      (room) => room.id === selectedId && room.players < room.maxPlayers,
    );
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
      const { enemies, asteroids } = room.arena;
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

  function updateJoinState() {
    joinButton.disabled = selectedId === null;
  }

  function onSubmit(event) {
    event.preventDefault();
    if (selectedId === null) return;

    lobby.playerName = nameInput.value;
    saveName(nameInput.value.trim());

    try {
      lobby.join(selectedId);
    } catch (error) {
      setStatus(error.message, { error: true });
    }
  }

  return {
    /** Показати лобі й почати оновлення. */
    show() {
      root.hidden = false;
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
          setStatus(`Не вдалося оновити список кімнат: ${title}. ${detail}`, {
            error: true,
            retry: true,
          });
        },
        { signal },
      );

      form.addEventListener('submit', onSubmit, { signal });
      retryButton.addEventListener('click', () => lobby.refresh(), { signal });

      // Вкладка у фоні — опитувати немає сенсу; повернулись — продовжуємо.
      document.addEventListener(
        'visibilitychange',
        () => (document.hidden ? lobby.stop() : lobby.start()),
        { signal },
      );

      renderRooms(lobby.rooms);
      setStatus('Завантаження кімнат…');
      lobby.start();
      nameInput.focus();
    },

    /** Сховати лобі: зняти слухачі й зупинити мережу (abort запиту в польоті). */
    hide() {
      root.hidden = true;
      listeners?.abort();
      listeners = null;
      lobby.stop();
    },
  };
}
