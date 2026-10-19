// ПОГАНИЙ приклад для порівняння: віддає файл, ігноруючи значення write().
// Не використовувати! Це контрприклад до /api/replays/:id.
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';

const [file, port] = [process.argv[2], Number(process.argv[3])];

createServer((req, res) => {
  if (req.url === '/health') {
    return res.end(JSON.stringify({ rss: process.memoryUsage().rss }));
  }
  const reader = createReadStream(file);
  // 'data' тече так швидко, як читає диск; write() повертає false, коли буфер
  // сокета повний, але ми цього не перевіряємо — усе, що клієнт не встиг
  // забрати, осідає в пам'яті процесу
  reader.on('data', (chunk) => res.write(chunk));
  reader.on('end', () => res.end());
}).listen(port, '127.0.0.1', () => console.log('naive ready'));
