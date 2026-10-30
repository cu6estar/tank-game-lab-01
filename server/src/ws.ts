import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { assertNever } from '@tank/shared/assert-never.ts';
import { CodecError, getCodec, peekType } from '@tank/shared/codec/index.ts';
import type { Codec } from '@tank/shared/codec/index.ts';
import { TICK_RATE } from '@tank/shared/constants.ts';
import { MSG } from '@tank/shared/protocol/constants.ts';
import type { ClientInput, CodecName, EncodedFrame } from '@tank/shared/protocol/types.ts';
import type { Config } from './config.ts';
import { CLOSE, parseMessage, server as msg } from './protocol.ts';
import type { CloseCode } from './protocol.ts';
import { slowClientAction } from './policy.ts';
import { TokenBucket } from './ratelimit.ts';
import { RoomError } from './rooms.ts';
import type { Room, RoomManager } from './rooms.ts';
import type { Logger, Player, SendOptions } from './types.ts';


// Причина в кадрі close — до 123 байт і краще ASCII. Людський текст іде
// окремим повідомленням { type: 'error' } перед закриттям.
const CLOSE_LABEL: Record<number, string> = {
  [CLOSE.JOIN_TIMEOUT]: 'join timeout',
  [CLOSE.BAD_MESSAGE]: 'bad message',
  [CLOSE.UNKNOWN_TYPE]: 'unknown type',
  [CLOSE.JOIN_REJECTED]: 'join rejected',
  [CLOSE.RATE_LIMIT]: 'rate limit',
  [CLOSE.SLOW_CLIENT]: 'slow client',
  [CLOSE.BAD_VERSION]: 'bad version',
  [CLOSE.UNSUPPORTED_DATA]: 'text only',
  [CLOSE.GOING_AWAY]: 'server shutting down',
};

interface ConnState {
  id: string;
  room: Room | null;
  player: Player | null;
  missedPongs: number;
  bucket: TokenBucket;
  codec?: Codec; // виставляється при join
  heartbeat?: () => void;
}

export interface WsStats {
  connections: number;
  dropped: number;
  closedByPolicy: number;
}

export interface WsServer {
  readonly wss: WebSocketServer;
  readonly stats: WsStats;
  readonly connections: number;
  close(options?: { graceMs?: number }): Promise<void>;
}

export interface AttachWsOptions {
  readonly server: Server;
  readonly rooms: RoomManager;
  readonly config: Config;
  readonly logger?: Logger;
}

/** ws віддає кадр як Buffer | ArrayBuffer | Buffer[]; зводимо до одного Buffer. */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

/**
 * WebSocket-шар: життєвий цикл з'єднання, heartbeat, ліміти, політика повільного клієнта.
 * Кімнати про сокети не знають: ми даємо їм "гравця" з методом send().
 */
export function attachWebSocketServer({ server, rooms, config, logger = console }: AttachWsOptions): WsServer {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: config.maxPayloadBytes, // більший кадр → ws сама закриває сокет кодом 1009
  });

  const stats: WsStats = { connections: 0, dropped: 0, closedByPolicy: 0 };
  const states = new WeakMap<WebSocket, ConnState>();

  wss.on('error', (error) => logger.error(`[ws] server error: ${error.message}`));

  wss.on('connection', (socket, req) => {
    // ПЕРШИМ ділом: слухач 'error' — без нього обрив з'єднання валить процес.
    socket.on('error', (error) => {
      logger.warn(`[ws ${state.id}] socket error: ${error.message}`);
    });

    const state: ConnState = {
      id: randomUUID().slice(0, 8),
      room: null,
      player: null,
      missedPongs: 0,
      bucket: new TokenBucket({ capacity: config.rateLimitPerSec, ratePerSec: config.rateLimitPerSec }),
    };
    states.set(socket, state);
    stats.connections += 1;
    logger.info(`[ws ${state.id}] connected from ${req.socket.remoteAddress}`);

    function closeWith(code: CloseCode, reasonText: string): void {
      if (socket.readyState === WebSocket.OPEN) {
        // помилка — "критичне" повідомлення, надсилаємо навіть повільному клієнту
        socket.send(JSON.stringify(msg.error(code, reasonText)), () => {});
        socket.close(code, CLOSE_LABEL[code] ?? 'closed');
        // клієнт може не відповісти на close-рукостискання — не чекаємо вічно
        setTimeout(() => socket.terminate(), 1000).unref();
      }
    }

    function fail(code: CloseCode, reasonText: string): void {
      logger.warn(`[ws ${state.id}] ${reasonText} → close ${code}`);
      closeWith(code, reasonText);
    }

    function send(message: unknown, options?: SendOptions): boolean {
      return sendFrame(JSON.stringify(message), options);
    }

    /** Те саме для вже закодованого кадру: рядок → текстовий, Uint8Array → бінарний. */
    function sendFrame(frame: EncodedFrame, { critical = true }: SendOptions = {}): boolean {
      if (socket.readyState !== WebSocket.OPEN) return false;

      const buffered = socket.bufferedAmount;
      const action = slowClientAction({
        buffered,
        critical,
        slowBytes: config.slowClientBytes,
        killBytes: config.killClientBytes,
      });
      if (action === 'kill') {
        stats.closedByPolicy += 1;
        fail(CLOSE.SLOW_CLIENT, `буфер ${buffered} Б перевищив ${config.killClientBytes} Б`);
        return false;
      }
      if (action === 'drop') {
        stats.dropped += 1;
        return false;
      }

      socket.send(frame, (error) => {
        if (error) logger.warn(`[ws ${state.id}] send failed: ${error.message}`);
      });
      return true;
    }

    // join чекаємо не довше joinTimeoutMs: мовчазні з'єднання не повинні висіти вічно
    const joinTimer = setTimeout(
      () => fail(CLOSE.JOIN_TIMEOUT, `join не надійшов за ${config.joinTimeoutMs} мс`),
      config.joinTimeoutMs,
    );

    function leaveRoom(): void {
      if (state.room && state.player) state.room.leave(state.player.id);
      state.room = null;
      state.player = null;
    }

    function onJoin(roomId: string, name: string, codec: CodecName): void {
      if (state.room) return fail(CLOSE.BAD_MESSAGE, 'повторний join');

      const room = rooms.get(roomId);
      if (!room) return fail(CLOSE.JOIN_REJECTED, 'такої кімнати немає');
      if (room.isFull) return fail(CLOSE.JOIN_REJECTED, `кімната "${room.name}" заповнена`);

      clearTimeout(joinTimer);
      // slot призначає кімната при join; 0 — лише заглушка до того
      const player: Player = { id: state.id, name, slot: 0, send, sendFrame, codec };
      state.codec = getCodec(codec);
      send(
        msg.welcome({ id: player.id, name }, { id: room.id, name: room.name }, { seed: room.seed, tickRate: TICK_RATE, codec }),
      );

      try {
        room.join(player);
      } catch (error: unknown) {
        if (error instanceof RoomError) return fail(CLOSE.JOIN_REJECTED, error.message);
        throw error;
      }
      state.room = room;
      state.player = player;
      logger.info(`[ws ${state.id}] ${name} → ${room.id}`);
    }

    function onBinary(buf: Buffer): void {
      const codec = state.codec;
      if (!codec) return fail(CLOSE.UNSUPPORTED_DATA, 'бінарний кадр до join');
      try {
        switch (peekType(buf)) {
          case MSG.INPUT:
            return onInput(codec.decodeInputs(buf));
          case MSG.PING:
            return onPing(codec.decodePing(buf), codec);
          default:
            return fail(CLOSE.UNKNOWN_TYPE, 'невідомий тип бінарного кадру');
        }
      } catch (error: unknown) {
        if (error instanceof CodecError) return fail(CLOSE.BAD_MESSAGE, `бінарний кадр: ${error.message}`);
        throw error;
      }
    }

    function onInput(inputs: readonly ClientInput[]): void {
      if (state.player) state.room?.match?.receiveInputs(state.player, inputs);
    }

    function onPing(t: number, codec: Codec): void {
      const tick = state.room?.match?.tick ?? 0;
      // pong відповідає тим самим кодеком, у якому клієнт надіслав ping
      sendFrame(codec.encodePong(t, tick), { critical: false });
    }

    socket.on('message', (data: RawData, isBinary: boolean) => {
      // ліміт перевіряємо ДО розбору: сміттєві кадри не повинні коштувати CPU
      if (!state.bucket.take()) {
        stats.closedByPolicy += 1;
        return fail(CLOSE.RATE_LIMIT, `більше ${config.rateLimitPerSec} повідомлень/с`);
      }
      const buf = toBuffer(data);
      if (isBinary) {
        // Бінарні кадри (ввід, ping) дозволені лише після join
        if (!state.room) return fail(CLOSE.UNSUPPORTED_DATA, 'бінарний кадр до join');
        return onBinary(buf);
      }

      const parsed = parseMessage(buf.toString('utf8'));
      if (!parsed.ok) return fail(parsed.code, parsed.reason);
      const { message } = parsed;

      if (!state.room) {
        if (message.type !== 'join') return fail(CLOSE.BAD_MESSAGE, 'першим має бути join');
        return onJoin(message.room, message.name, message.codec);
      }

      switch (message.type) {
        case 'join':
          return fail(CLOSE.BAD_MESSAGE, 'повторний join');
        case 'chat':
          state.room.chat(state.player?.id ?? state.id, message.text);
          return;
        case 'input':
          return onInput(message.inputs);
        case 'ping':
          return onPing(message.t, getCodec('json'));
        case 'leave':
          leaveRoom();
          socket.close(CLOSE.NORMAL, 'bye');
          return;
        default:
          return assertNever(message);
      }
    });

    socket.on('pong', () => {
      state.missedPongs = 0;
    });
    state.heartbeat = (): void => {
      if (state.missedPongs >= config.maxMissedPongs) {
        logger.warn(`[ws ${state.id}] ${state.missedPongs} пропущених pong → terminate`);
        socket.terminate(); // close-рукостискання не чекаємо: клієнт, найімовірніше, мертвий
        return;
      }
      state.missedPongs += 1;
      socket.ping();
    };

    socket.on('close', (code) => {
      clearTimeout(joinTimer);
      leaveRoom();
      stats.connections -= 1;
      logger.info(`[ws ${state.id}] closed (${code})`);
    });
  });

  // Один таймер на весь сервер: ping усім, а хто не відповів двічі — геть
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) states.get(socket)?.heartbeat?.();
  }, config.heartbeatMs);

  return {
    wss,
    stats,
    get connections(): number {
      return wss.clients.size;
    },
    /** Закрити всі сокети кодом 1001 і дочекатись, поки клієнти підтвердять. */
    async close({ graceMs = config.shutdownGraceMs }: { graceMs?: number } = {}): Promise<void> {
      clearInterval(heartbeat);

      for (const socket of wss.clients) {
        socket.close(CLOSE.GOING_AWAY, CLOSE_LABEL[CLOSE.GOING_AWAY]);
      }

      const forced = setTimeout(() => {
        for (const socket of wss.clients) socket.terminate();
      }, graceMs);

      await new Promise<void>((resolve) => wss.close(() => resolve()));
      clearTimeout(forced);
    },
  };
}
