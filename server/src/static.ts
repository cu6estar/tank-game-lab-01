import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, extname, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Logger } from './types.ts';
import { errnoCode, errorMessage } from './types.ts';

export const MIME: Readonly<Record<string, string>> = {
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
};

export const mimeFor = (path: string): string => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

export type StaticResolution = { status: 200; path: string } | { status: 400 | 403; reason: string };

/**
 * Перетворює URL-шлях на шлях усередині `root` — або повідомляє, чому не можна.
 * Захист від path traversal: відхиляємо ".." (також %2e%2e), перевіряємо префікс
 * root після join, а symlink-перевірку робить serveStatic через realpath.
 */
export function resolveStaticPath(root: string, rawUrl: string): StaticResolution {
  const raw = (rawUrl.split('?')[0] ?? '').split('#')[0] ?? '';

  let decoded: string;
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

const text = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void => {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
};

export interface ServeStaticOptions {
  readonly root: string;
  readonly logger?: Logger;
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, { root, logger = console }: ServeStaticOptions): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  const resolved = resolveStaticPath(root, req.url ?? '/');
  if (resolved.status !== 200) return text(res, resolved.status, resolved.reason);

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return text(res, 404, 'Клієнт не зібрано: виконайте `npm run build` (або відкрийте Vite на :5173).');
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
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') return void res.end();

    // pipeline: backpressure від повільного клієнта і закриття файлу при обриві
    await pipeline(createReadStream(real), res);
  } catch (error: unknown) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!res.headersSent) return text(res, 404, 'Not Found');
    } else if (code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.error(`[static] ${req.url}: ${errorMessage(error)}`);
      if (!res.headersSent) return text(res, 500, 'Internal Server Error');
    }
    res.destroy(); // заголовки вже пішли — залишається лише обірвати з'єднання
  }
}
