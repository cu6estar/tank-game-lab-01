// Що буде, якщо один обробник HTTP на 300 мс займе цикл подій?
// Піднімаємо справжній застосунок з DEMO_ENDPOINTS=1, двоє гравців у кімнаті;
// Alice раз на 50 мс шле чат, а Bob міряє, через скільки той долетів.
// На 500-й мс з третього клієнта б'ємо в GET /api/slow (busy-loop 300 мс).
// Запуск: node experiments/event-loop-block.js
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

// Сервер — ОКРЕМИЙ процес: інакше busy-loop заморозив би і самих клієнтів-вимірювачів,
// і ми б не побачили, як довго чекають "чужі" повідомлення.
const root = await mkdtemp(join(tmpdir(), 'loop-'));
const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const server = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    PORT: String(port),
    LOG_DIR: join(root, 'logs'),
    STATIC_DIR: root,
    DEMO_ENDPOINTS: '1',
    RATE_LIMIT_PER_SEC: '100',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) =>
  server.stdout.on('data', (d) => /http:\/\//.test(d) && resolve()),
);

function client(name) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox = [];
  socket.on('message', (d) =>
    inbox.push({ at: performance.now(), msg: JSON.parse(d) }),
  );
  return new Promise((resolve) =>
    socket.on('open', () => {
      socket.send(
        JSON.stringify({ type: 'join', v: 1, room: 'training', name }),
      );
      resolve({ socket, inbox });
    }),
  );
}

const alice = await client('Alice');
const bob = await client('Bob');
await new Promise((r) => setTimeout(r, 100));

const sentAt = new Map();
let seq = 0;
const ticker = setInterval(() => {
  const text = `m${seq++}`;
  sentAt.set(text, performance.now());
  alice.socket.send(JSON.stringify({ type: 'chat', text }));
}, 50);

const T0 = performance.now();
setTimeout(() => {
  const started = performance.now();
  fetch(`http://127.0.0.1:${port}/api/slow`).then(async (r) => {
    const body = await r.json();
    console.log(
      `/api/slow відповів через ${(performance.now() - started).toFixed(0)} мс (busy-loop: ${body.blockedMs} мс)`,
    );
  });
}, 500);

await new Promise((r) => setTimeout(r, 1500));
clearInterval(ticker);

const rows = bob.inbox
  .filter(({ msg }) => msg.type === 'chat' && sentAt.has(msg.text))
  .map(({ at, msg }) => ({
    text: msg.text,
    sentMs: sentAt.get(msg.text) - T0,
    latency: at - sentAt.get(msg.text),
  }));

console.log('\nчат Alice → Bob (бачить лише ті, що доїхали):');
console.log('  відправлено, мс   затримка, мс');
for (const row of rows.filter((r) => r.sentMs > 350 && r.sentMs < 950)) {
  const bar = '█'.repeat(Math.min(40, Math.round(row.latency / 8)));
  console.log(
    `  ${row.sentMs.toFixed(0).padStart(8)}        ${row.latency.toFixed(0).padStart(5)}   ${bar}`,
  );
}
const normal = rows
  .filter((r) => r.sentMs < 450 || r.sentMs > 1000)
  .map((r) => r.latency);
console.log(
  `\nзвичайна затримка: ~${(normal.reduce((a, b) => a + b, 0) / normal.length).toFixed(1)} мс, максимум під час блоку: ${Math.max(...rows.map((r) => r.latency)).toFixed(0)} мс`,
);

alice.socket.close();
bob.socket.close();
server.kill('SIGTERM');
