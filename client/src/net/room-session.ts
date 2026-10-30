import type { CodecName } from '@tank/shared/protocol/types.ts';
import { Connection } from './connection.ts';
import type { LagInjector } from './lag.ts';
import type {
  ChatMessage,
  ErrorMessage,
  PlayerRef,
  RosterMessage,
  WelcomeMessage,
} from './messages.ts';

export const PROTOCOL_VERSION = 2;

export function defaultWsUrl(location: Location = globalThis.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

const REASONS: Record<number, string> = {
  4000: 'сервер не дочекався join',
  4003: 'кімнату не знайдено або вона заповнена',
  4004: 'забагато повідомлень',
  4005: "з'єднання надто повільне",
  4006: 'версія клієнта застаріла — оновіть сторінку',
};

export type RosterPlayers = RosterMessage['players'];

/** UI чату/статусу, який сесія оновлює (реалізує chat-ui.ts). */
export interface RoomUi {
  setStatus(state: string, text: string): void;
  addSystem(text: string): void;
  setRoster(players: RosterPlayers, selfId?: string): void;
  addChat(message: ChatMessage, selfId?: string): void;
}

export interface JoinRoomOptions {
  readonly url?: string;
  readonly roomId: string;
  readonly name: string;
  readonly ui: RoomUi;
  readonly onRejected?: (info: { code: number; reason: string }) => void;
  readonly codec?: CodecName;
  readonly onWelcome?: (message: WelcomeMessage) => void;
  readonly onRoster?: (players: RosterPlayers, me: PlayerRef | null) => void;
  readonly lag?: LagInjector | null;
  readonly onBinary?: ((frame: Uint8Array) => void) | null;
}

export interface RoomSession {
  readonly connection: Connection;
  sendChat(text: string): 'sent' | 'queued' | 'dropped';
  leave(): void;
}

/**
 * Підключає гравця до кімнати: Connection + прив'язка до чату. Рукостискання
 * (join) відправляється після КОЖНОГО підключення, тож після обриву гравець
 * повертається в ту саму кімнату сам.
 */
export function joinRoomSession({
  url = defaultWsUrl(),
  roomId,
  name,
  ui,
  onRejected,
  codec = 'json',
  onWelcome,
  onRoster,
  lag = null,
  onBinary = null,
}: JoinRoomOptions): RoomSession {
  let me: PlayerRef | null = null;
  let everOpened = false;
  const controller = new AbortController();
  const { signal } = controller;

  const connection = new Connection({
    url,
    handshake: () => ({ type: 'join', v: PROTOCOL_VERSION, room: roomId, name, codec }),
    lag,
    onBinary,
  });

  connection.on<WelcomeMessage>(
    'welcome',
    (message) => {
      me = message.you;
      onWelcome?.(message);
      ui.setStatus('open', `у мережі · ${message.room.name}`);
      ui.addSystem(everOpened ? 'Підключення відновлено' : `Ви в кімнаті «${message.room.name}»`);
      everOpened = true;
    },
    { signal },
  );
  connection.on<RosterMessage>(
    'roster',
    (message) => {
      ui.setRoster(message.players, me?.id);
      onRoster?.(message.players, me);
    },
    { signal },
  );
  connection.on<ChatMessage>('chat', (message) => ui.addChat(message, me?.id), { signal });
  connection.on<ErrorMessage>('error', (message) => ui.addSystem(`Сервер: ${message.message}`), { signal });

  connection.addEventListener(
    'reconnecting',
    (event) => {
      const { attempt, delayMs } = event.detail;
      const seconds = (delayMs / 1000).toFixed(1);
      ui.setStatus('reconnecting', `зв'язок втрачено · спроба ${attempt} через ${seconds} с`);
      if (attempt === 1) ui.addSystem("З'єднання втрачено, повторне підключення…");
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
    sendChat(text: string): 'sent' | 'queued' | 'dropped' {
      const result = connection.send({ type: 'chat', text });
      if (result === 'queued') ui.addSystem("Немає зв'язку — повідомлення буде надіслано після підключення");
      if (result === 'dropped') ui.addSystem('Повідомлення не надіслано (черга переповнена)');
      return result;
    },
    leave(): void {
      controller.abort();
      if (connection.state === 'open') connection.send({ type: 'leave' });
      connection.close();
    },
  };
}
