// Генератор синтетичного логу матчу: N МБ рядків NDJSON, схожих на справжні події.
// Сам теж пише через pipeline, тож 200 МБ не вантажаться в пам'ять.
// Запуск: node tools/make-big-log.js [шлях] [МБ]
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const WORDS = [
  'вогонь',
  'ціль',
  'щит',
  'астероїд',
  'ліворуч',
  'відхід',
  'прикрий',
  'gg',
  'rapid',
  'homing',
];

export async function makeBigLog(path, megabytes = 200) {
  const target = megabytes * 1024 * 1024;
  await mkdir(dirname(path), { recursive: true });

  function* batches() {
    let written = 0;
    let i = 0;
    const t0 = Date.parse('2026-10-20T10:00:00Z');
    while (written < target) {
      let batch = '';
      for (let k = 0; k < 800; k++, i++) {
        const type = i % 7 === 0 ? 'chat' : i % 3 === 0 ? 'hit' : 'state';
        batch +=
          JSON.stringify({
            t: t0 + i * 16,
            type,
            player: { id: `p${i % 8}`, name: `Pilot${i % 8}` },
            text:
              type === 'chat'
                ? `${WORDS[i % 10]} ${WORDS[(i * 7) % 10]}`
                : undefined,
            x: +(Math.sin(i / 50) * 400 + 500).toFixed(2),
            y: +(Math.cos(i / 70) * 300 + 400).toFixed(2),
            hp: 100 - (i % 100),
          }) + '\n';
      }
      written += Buffer.byteLength(batch);
      yield batch;
    }
  }

  await pipeline(
    Readable.from(batches(), { objectMode: false }),
    createWriteStream(path),
  );
  return target;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const path = resolve(process.argv[2] ?? 'logs/synthetic-200mb.ndjson');
  const mb = Number(process.argv[3] ?? 200);
  const bytes = await makeBigLog(path, mb);
  console.log(`${path}: ≥ ${(bytes / 1024 / 1024).toFixed(0)} МБ`);
}
