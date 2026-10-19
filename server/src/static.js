import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

export const mimeFor = (path) =>
  MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * Перетворює URL-шлях на шлях усередині `root` — або повідомляє, чому не можна.
 *
 * Захист від path traversal у три шари:
 *   1. відхиляємо будь-який сегмент ".." (також у вигляді %2e%2e — спершу декодуємо);
 *   2. після join перевіряємо, що результат усе ще починається з root;
 *   3. realpath: symlink усередині root не повинен вести назовні.
 * Сирий req.url НЕ можна розбирати через new URL(): вона мовчки "схлопує" /../
 * і приховує спробу атаки від наших перевірок.
 */
export function resolveStaticPath(root, rawUrl) {
  const raw = rawUrl.split('?')[0].split('#')[0];

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { status: 400, reason: 'некоректне кодування URL' };
  }

  if (decoded.includes('\0')) return { status: 400, reason: 'NUL у шляху' };
  // і "/", і "\" — щоб ..\ не пройшло на Windows
  if (decoded.split(/[\\/]+/).includes('..')) {
    return { status: 403, reason: 'шляхи з ".." заборонені' };
  }

  const target = join(root, decoded);
  if (target !== root && !target.startsWith(root + sep)) {
    return { status: 403, reason: 'вихід за межі каталогу' };
  }
  return { status: 200, path: target };
}

const text = (res, status, body, headers = {}) => {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
};

export async function serveStatic(req, res, { root, logger = console }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const resolved = resolveStaticPath(root, req.url ?? '/');
  if (resolved.status !== 200)
    return text(res, resolved.status, resolved.reason);

  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return text(
      res,
      404,
      'Клієнт не зібрано: виконайте `npm run build` (або відкрийте Vite на :5173).',
    );
  }

  let file = resolved.path;
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file);
    }

    const real = await realpath(file);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return text(res, 403, 'symlink веде за межі каталогу');
    }

    const type = mimeFor(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      // index.html завжди перевіряємо заново; решта (імена з хешем) — кешуємо
      'Cache-Control': type.startsWith('text/html')
        ? 'no-cache'
        : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return res.end();

    // pipeline: backpressure від повільного клієнта і закриття файлу при обриві
    await pipeline(createReadStream(real), res);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      if (!res.headersSent) return text(res, 404, 'Not Found');
    } else if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.error(`[static] ${req.url}: ${error.message}`);
      if (!res.headersSent) return text(res, 500, 'Internal Server Error');
    }
    res.destroy(); // заголовки вже пішли — залишається лише обірвати з'єднання
  }
}
