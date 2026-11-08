import { pino } from 'pino';
import type { Logger } from '../types.ts';

/**
 * Логи — рядки JSON через pino (один об'єкт на рядок: рівень, час, msg, поля).
 * Наш внутрішній інтерфейс Logger простий — `info/warn/error(...args)`, тому
 * тут адаптер: якщо першим аргументом іде об'єкт, він стає структурованими
 * полями (id кімнати/гравця), решта — текстом повідомлення.
 *
 * `redact` гасить потенційно чутливі поля, щоб паролі/ключі не потрапили в лог,
 * навіть якщо колись їх випадково передадуть у структуру.
 */
export function createLogger(options: { level?: string; name?: string } = {}): Logger {
  const base = pino({
    level: options.level ?? 'info',
    name: options.name ?? 'tank-arena',
    redact: {
      paths: ['password', 'token', 'secret', 'key', 'authorization', '*.password', '*.token'],
      censor: '[redacted]',
    },
  });

  const emit = (level: 'info' | 'warn' | 'error', args: unknown[]): void => {
    const [first, ...rest] = args;
    if (first !== null && typeof first === 'object') {
      base[level](first, rest.map(String).join(' '));
    } else {
      base[level](args.map(String).join(' '));
    }
  };

  return {
    info: (...args: unknown[]): void => emit('info', args),
    warn: (...args: unknown[]): void => emit('warn', args),
    error: (...args: unknown[]): void => emit('error', args),
  };
}
