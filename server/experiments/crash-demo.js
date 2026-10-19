// Чому "error" без слухача валить ВЕСЬ процес — і як це виглядає в логу.
// Режими (аргумент):
//   emitter-bad     WebSocket без слухача 'error' + кадр більший за maxPayload
//   emitter-fixed   те саме, але з socket.on('error', …)
//   promise-bad     async-обробник повідомлення кидає виняток, ніхто не робить await/catch
//   promise-fixed   той самий обробник з try/catch
// Запуск усіх: node experiments/crash-demo.js            (по одному в дочірньому процесі)
//     одного: node experiments/crash-demo.js emitter-bad
import { spawnSync } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';

const mode = process.argv[2];

if (!mode) {
  for (const m of [
    'emitter-bad',
    'emitter-fixed',
    'promise-bad',
    'promise-fixed',
  ]) {
    const run = spawnSync(process.execPath, [import.meta.filename, m], {
      encoding: 'utf8',
      timeout: 5000,
    });
    console.log(`\n=== ${m}: код виходу ${run.status} ===`);
    // лише суть: перші рядки stderr (стек довгий) + stdout
    const stderr = run.stderr
      .trim()
      .split('\n')
      .filter(
        (l) => !l.includes('node_modules/') && !l.includes('node:internal'),
      );
    console.log(
      [run.stdout.trim(), ...stderr.slice(0, 9)].filter(Boolean).join('\n'),
    );
  }
  process.exit(0);
}

const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
wss.on('connection', (socket) => {
  if (mode === 'emitter-fixed') {
    socket.on('error', (error) =>
      console.log(`[ws] помилка сокета оброблено: ${error.message}`),
    );
  }
  if (mode.startsWith('promise')) {
    socket.on('message', async () => {
      if (mode === 'promise-fixed') {
        try {
          await Promise.reject(new Error('БД недоступна'));
        } catch (error) {
          console.log(`[ws] помилку обробника перехоплено: ${error.message}`);
        }
      } else {
        await Promise.reject(new Error('БД недоступна')); // async-функція повертає проміс; його ніхто не чекає
      }
    });
  }
});

wss.on('listening', () => {
  const client = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  client.on('error', () => {});
  client.on('open', () =>
    client.send(mode.startsWith('emitter') ? 'x'.repeat(2048) : 'ping'),
  );
  client.on('close', () => {});
});

// якщо процес пережив помилку — це видно з наступного рядка
setTimeout(() => {
  console.log('[server] процес живий, сервер працює далі');
  process.exit(0);
}, 500);
