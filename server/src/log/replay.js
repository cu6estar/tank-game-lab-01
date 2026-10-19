import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export class ReplayError extends Error {
  constructor(message, { line, cause } = {}) {
    super(message, { cause });
    this.name = 'ReplayError';
    this.line = line;
  }
}

/** id повтору — ім'я файлу без розширення; лише безпечні символи (жодних / і ..). */
export const REPLAY_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function replayPath(dir, id) {
  if (!REPLAY_ID.test(id)) return null;
  return join(dir, `${id}.ndjson`);
}

export async function listReplays(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const replays = [];
  for (const name of names) {
    if (!name.endsWith('.ndjson')) continue;
    const id = name.slice(0, -'.ndjson'.length);
    if (!REPLAY_ID.test(id)) continue;
    const { size, mtimeMs } = await stat(join(dir, name));
    replays.push({
      id,
      bytes: size,
      modified: new Date(mtimeMs).toISOString(),
    });
  }
  return replays.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Асинхронний генератор подій з NDJSON-файлу. Файл читається потоком, у пам'яті
 * лише поточний шматок (64 КБ) і недочитаний хвіст рядка. Шматок може обірватись
 * посеред рядка (і навіть посеред UTF-8 символу, тому читаємо з encoding: 'utf8',
 * який склеює багатобайтові послідовності сам), тож "хвіст" переходить у наступну ітерацію.
 */
export async function* replay(path) {
  const stream = createReadStream(path, { encoding: 'utf8' });
  let tail = '';
  let lineNo = 0;

  const parse = (line) => {
    lineNo += 1;
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new ReplayError(`рядок ${lineNo}: не JSON`, {
        line: lineNo,
        cause,
      });
    }
  };

  for await (const chunk of stream) {
    const lines = (tail + chunk).split('\n');
    tail = lines.pop(); // останній елемент — або '', або початок наступного рядка

    for (const line of lines) {
      if (line.trim() !== '') yield parse(line);
    }
  }

  // Файл без фінального '\n' (процес вбили посеред запису): хвіст ще може бути валідним
  if (tail.trim() !== '') {
    try {
      yield parse(tail);
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error;
      // обрізаний останній рядок ігноруємо: це наслідок аварійної зупинки, а не помилка даних
    }
  }
}
