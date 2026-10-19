import { Connection } from './connection.js';

export const PROTOCOL_VERSION = 1;

export function defaultWsUrl(location = globalThis.location) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

const REASONS = {
  4000: 'сервер не дочекався join',
  4003: 'кімнату не знайдено або вона заповнена',
  4004: 'забагато повідомлень',
  4005: "з'єднання надто повільне",
  4006: 'версія клієнта застаріла — оновіть сторінку',
};

/**
 * Підключає гравця до кімнати: Connection + прив'язка до чату.
 * Рукостискання (join) відправляється автоматично після КОЖНОГО підключення,
 * тож після обриву гравець повертається в ту саму кімнату сам.
 */
export function joinRoomSession({
  url = defaultWsUrl(),
  roomId,
  name,
  ui,
  onRejected,
  ...options
}) {
  let me = null;
  let everOpened = false;
  const controller = new AbortController();
  const { signal } = controller;

  const connection = new Connection({
    url,
    handshake: () => ({
      type: 'join',
      v: PROTOCOL_VERSION,
      room: roomId,
      name,
    }),
    ...options,
  });

  connection.on(
    'welcome',
    (message) => {
      me = message.you;
      ui.setStatus('open', `у мережі · ${message.room.name}`);
      ui.addSystem(
        everOpened
          ? 'Підключення відновлено'
          : `Ви в кімнаті «${message.room.name}»`,
      );
      everOpened = true;
    },
    { signal },
  );
  connection.on('roster', (message) => ui.setRoster(message.players, me?.id), {
    signal,
  });
  connection.on('chat', (message) => ui.addChat(message, me?.id), { signal });
  connection.on(
    'error',
    (message) => ui.addSystem(`Сервер: ${message.message}`),
    { signal },
  );

  connection.addEventListener(
    'reconnecting',
    (event) => {
      const { attempt, delayMs } = event.detail;
      const seconds = (delayMs / 1000).toFixed(1);
      ui.setStatus(
        'reconnecting',
        `зв'язок втрачено · спроба ${attempt} через ${seconds} с`,
      );
      if (attempt === 1)
        ui.addSystem("З'єднання втрачено, повторне підключення…");
    },
    { signal },
  );
  connection.addEventListener(
    'fatal',
    (event) => {
      const { code } = event.detail;
      const reason = REASONS[code] ?? `з'єднання закрито (код ${code})`;
      ui.setStatus('closed', reason);
      onRejected?.({ code, reason });
    },
    { signal },
  );

  ui.setStatus('connecting', 'підключення…');
  connection.connect();

  return {
    connection,
    /** Повідомлення чату. Якщо зв'язку немає — піде в чергу й відправиться після reconnect. */
    sendChat(text) {
      const result = connection.send({ type: 'chat', text });
      if (result === 'queued')
        ui.addSystem(
          "Немає зв'язку — повідомлення буде надіслано після підключення",
        );
      if (result === 'dropped')
        ui.addSystem('Повідомлення не надіслано (черга переповнена)');
      return result;
    },
    leave() {
      controller.abort();
      if (connection.state === 'open') connection.send({ type: 'leave' });
      connection.close();
    },
  };
}
