import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { CodecError, getCodec, peekType } from '@tank/shared/codec/index.js';
import { TICK_RATE } from '@tank/shared/constants.js';
import { MSG } from '@tank/shared/protocol/constants.js';
import { CLOSE, parseMessage, server as msg } from './protocol.js';
import { slowClientAction } from './policy.js';
import { TokenBucket } from './ratelimit.js';
import { RoomError } from './rooms.js';

// Причина в кадрі close — до 123 байт і краще ASCII (Ukrainian — по 2 байти на літеру).
// Людський текст іде окремим повідомленням { type: 'error' } перед закриттям.
const CLOSE_LABEL = {
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

/**
 * WebSocket-шар: життєвий цикл з'єднання, heartbeat, ліміти, політика повільного клієнта.
 * Кімнати про сокети не знають: ми даємо їм "гравця" з методом send().
 */
export function attachWebSocketServer({
  server,
  rooms,
  config,
  logger = console,
}) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: config.maxPayloadBytes, // більший кадр → ws сама закриває сокет кодом 1009
  });

  const stats = { connections: 0, dropped: 0, closedByPolicy: 0 };

  // Помилки самого сервера (напр. EADDRINUSE при listen) — теж "error" без слухача = crash
  wss.on('error', (error) =>
    logger.error(`[ws] server error: ${error.message}`),
  );

  wss.on('connection', (socket, req) => {
    // ПЕРШИМ ділом: слухач 'error'. WebSocket — EventEmitter; обрив з'єднання,
    // зламаний кадр чи переповнений буфер емітять 'error', і без слухача
    // це uncaught exception, що вбиває весь сервер (і всі кімнати) через одного клієнта.
    socket.on('error', (error) => {
      logger.warn(`[ws ${state.id}] socket error: ${error.message}`);
    });

    const state = {
      id: randomUUID().slice(0, 8),
      room: null,
      player: null,
      missedPongs: 0,
      bucket: new TokenBucket({
        capacity: config.rateLimitPerSec,
        ratePerSec: config.rateLimitPerSec,
      }),
    };
    stats.connections += 1;
    logger.info(`[ws ${state.id}] connected from ${req.socket.remoteAddress}`);

    function closeWith(code, reasonText) {
      if (socket.readyState === WebSocket.OPEN) {
        // помилка — "критичне" повідомлення, надсилаємо навіть повільному клієнту
        socket.send(JSON.stringify(msg.error(code, reasonText)), () => {});
        socket.close(code, CLOSE_LABEL[code] ?? 'closed');
        // клієнт може не відповісти на close-рукостискання — не чекаємо вічно
        setTimeout(() => socket.terminate(), 1000).unref();
      }
    }

    function fail(code, reasonText) {
      logger.warn(`[ws ${state.id}] ${reasonText} → close ${code}`);
      closeWith(code, reasonText);
    }

    /**
     * Політика повільного клієнта. bufferedAmount — байти, які ми вже віддали
     * в socket.send(), але ядро ще не відправило (клієнт читає повільно).
     *   > slowClientBytes  — некритичне (чат) просто пропускаємо;
     *   > killClientBytes  — клієнта не наздогнати, закриваємо сокет.
     * Без цього кожне наступне send() лише збільшувало б чергу в пам'яті сервера.
     */
    function send(message, options) {
      return sendFrame(JSON.stringify(message), options);
    }

    /** Те саме для вже закодованого кадру: рядок → текстовий, Uint8Array → бінарний. */
    function sendFrame(frame, { critical = true } = {}) {
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
        fail(
          CLOSE.SLOW_CLIENT,
          `буфер ${buffered} Б перевищив ${config.killClientBytes} Б`,
        );
        return false;
      }
      if (action === 'drop') {
        stats.dropped += 1;
        return false;
      }

      socket.send(frame, (error) => {
        if (error)
          logger.warn(`[ws ${state.id}] send failed: ${error.message}`);
      });
      return true;
    }

    // join чекаємо не довше joinTimeoutMs (5 с): мовчазні з'єднання не повинні висіти вічно
    const joinTimer = setTimeout(
      () =>
        fail(
          CLOSE.JOIN_TIMEOUT,
          `join не надійшов за ${config.joinTimeoutMs} мс`,
        ),
      config.joinTimeoutMs,
    );

    function leaveRoom() {
      if (state.room && state.player) state.room.leave(state.player.id);
      state.room = null;
      state.player = null;
    }

    function onJoin({ room: roomId, name, codec }) {
      if (state.room) return fail(CLOSE.BAD_MESSAGE, 'повторний join');

      const room = rooms.get(roomId);
      if (!room) {
        return fail(CLOSE.JOIN_REJECTED, 'такої кімнати немає');
      }
      if (room.isFull) {
        return fail(CLOSE.JOIN_REJECTED, `кімната "${room.name}" заповнена`);
      }

      clearTimeout(joinTimer);
      const player = { id: state.id, name, send, sendFrame, codec };
      state.codec = getCodec(codec);
      // welcome — до першого roster, який room.join розішле всім.
      // Слот гравця приходить у roster (його призначає кімната при join).
      send(
        msg.welcome(
          { id: player.id, name },
          { id: room.id, name: room.name },
          { seed: room.seed, tickRate: TICK_RATE, codec },
        ),
      );

      try {
        room.join(player);
      } catch (error) {
        if (error instanceof RoomError)
          return fail(CLOSE.JOIN_REJECTED, error.message);
        throw error;
      }
      state.room = room;
      state.player = player;
      logger.info(`[ws ${state.id}] ${name} → ${room.id}`);
    }

    function onBinary(data) {
      try {
        switch (peekType(data)) {
          case MSG.INPUT:
            return onInput(state.codec.decodeInputs(data));
          case MSG.PING:
            return onPing(state.codec.decodePing(data), state.codec);
          default:
            return fail(CLOSE.UNKNOWN_TYPE, 'невідомий тип бінарного кадру');
        }
      } catch (error) {
        if (error instanceof CodecError)
          return fail(CLOSE.BAD_MESSAGE, `бінарний кадр: ${error.message}`);
        throw error;
      }
    }

    function onInput(inputs) {
      state.room.match?.receiveInputs(state.player, inputs);
    }

    function onPing(t, codec) {
      const tick = state.room.match?.tick ?? 0;
      // pong відповідає тим самим кодеком, у якому клієнт надіслав ping
      sendFrame(codec.encodePong(t, tick), { critical: false });
    }

    socket.on('message', (data, isBinary) => {
      // ліміт перевіряємо ДО розбору: сміттєві кадри не повинні коштувати CPU
      if (!state.bucket.take()) {
        stats.closedByPolicy += 1;
        return fail(
          CLOSE.RATE_LIMIT,
          `більше ${config.rateLimitPerSec} повідомлень/с`,
        );
      }
      if (isBinary) {
        // Бінарні кадри (ввід, ping) дозволені лише після join
        if (!state.room)
          return fail(CLOSE.UNSUPPORTED_DATA, 'бінарний кадр до join');
        return onBinary(data);
      }

      const parsed = parseMessage(data.toString('utf8'));
      if (!parsed.ok) return fail(parsed.code, parsed.reason);
      const { message } = parsed;

      if (!state.room) {
        if (message.type !== 'join')
          return fail(CLOSE.BAD_MESSAGE, 'першим має бути join');
        return onJoin(message);
      }

      switch (message.type) {
        case 'join':
          return fail(CLOSE.BAD_MESSAGE, 'повторний join');
        case 'chat':
          return void state.room.chat(state.player.id, message.text);
        case 'input':
          return onInput(message.inputs);
        case 'ping':
          return onPing(message.t, getCodec('json'));
        case 'leave':
          leaveRoom();
          return socket.close(CLOSE.NORMAL, 'bye');
      }
    });

    socket.on('pong', () => {
      state.missedPongs = 0;
    });
    state.heartbeat = () => {
      if (state.missedPongs >= config.maxMissedPongs) {
        logger.warn(
          `[ws ${state.id}] ${state.missedPongs} пропущених pong → terminate`,
        );
        return socket.terminate(); // close-рукостискання не чекаємо: клієнт, найімовірніше, мертвий
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

    socket.state = state;
  });

  // Один таймер на весь сервер: ping усім, а хто не відповів двічі — геть
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) socket.state?.heartbeat();
  }, config.heartbeatMs);

  return {
    wss,
    stats,
    get connections() {
      return wss.clients.size;
    },
    /** Закрити всі сокети кодом 1001 і дочекатись, поки клієнти підтвердять. */
    async close({ graceMs = config.shutdownGraceMs } = {}) {
      clearInterval(heartbeat);

      for (const socket of wss.clients) {
        socket.close(CLOSE.GOING_AWAY, CLOSE_LABEL[CLOSE.GOING_AWAY]);
      }

      const forced = setTimeout(() => {
        for (const socket of wss.clients) socket.terminate();
      }, graceMs);

      await new Promise((resolve) => wss.close(resolve));
      clearTimeout(forced);
    },
  };
}
