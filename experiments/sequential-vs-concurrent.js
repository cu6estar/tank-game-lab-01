// Експеримент: ті самі 5 файлів з manifest.json, дві стратегії завантаження.
//   sequential: for + await по черзі      → час ≈ СУМА затримок
//   concurrent: loadAll (Promise.all)      → час ≈ МАКСИМУМ затримок
// Сервер локальний, кожному файлу штучно додаємо затримку (імітація мережі).
// Запуск: npm run exp:timing [-- затримка_мс]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  loadAll,
  loadJson,
  loadImage,
  loadAudio,
} from '../src/assets/loader.js';

const DELAY = Number(process.argv[2] ?? 200);
const ROOT = new URL('../public/', import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL('assets/manifest.json', ROOT), 'utf8'),
);

const server = createServer(async (req, res) => {
  await new Promise((r) => setTimeout(r, DELAY));
  try {
    const body = await readFile(new URL(`.${req.url}`, ROOT));
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

// Node не має createImageBitmap/AudioContext — підставляємо заглушки декодування,
// мережа при цьому справжня (саме її ми міряємо).
const options = {
  decodeImage: async (blob) => ({ size: blob.size }),
  retry: false,
};
const audioContext = {
  decodeAudioData: async (data) => ({ bytes: data.byteLength }),
};
const abs = (entry) => ({ ...entry, url: origin + entry.url });
const entries = manifest.assets.map(abs);

async function sequential() {
  for (const entry of entries) {
    if (entry.type === 'json') await loadJson(entry.url, options);
    else if (entry.type === 'image') await loadImage(entry.url, options);
    else await loadAudio(audioContext, entry.url, options);
  }
}

const concurrent = () =>
  loadAll({ assets: entries }, { audioContext, ...options });

async function time(label, fn) {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(11)} ${ms.toFixed(0).padStart(5)} мс`);
  return ms;
}

console.log(`файлів: ${entries.length}, затримка сервера на файл: ${DELAY} мс`);
const seq = await time('sequential', sequential);
const con = await time('concurrent', concurrent);
console.log(
  `очікування: sequential ≈ ${entries.length}×${DELAY} = ${entries.length * DELAY} мс, concurrent ≈ ${DELAY} мс`,
);
console.log(`прискорення: ×${(seq / con).toFixed(1)}`);
server.close();
