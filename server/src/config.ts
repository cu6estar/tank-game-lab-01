import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Уся конфігурація сервера — тут і лише тут. Решта коду не читає process.env:
 * вона отримує готовий, перевірений об'єкт. У лабі 4 перевірка була ручною;
 * тепер оточення проходить через СХЕМУ Zod, тому помилка в .env видна одразу
 * при старті ("PORT має бути цілим…"), а не через годину як дивний збій у мережі.
 *
 * Усі змінні необов'язкові (є розумні значення за замовчуванням), але якщо
 * змінну задано — вона мусить бути коректною.
 */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Некоректна конфігурація:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const blankToUndef = (v: unknown): unknown => (v === '' || v === undefined ? undefined : v);

/** Ціле зі суворим рядковим форматом: "1e3"/"12abc"/"3.5" не проходять (на відміну від Number()). */
const envInt = (def: number, min: number, max: number) =>
  z.preprocess(
    blankToUndef,
    z
      .string()
      .regex(/^-?\d+$/, 'має бути цілим числом')
      .transform((s) => Number(s))
      .pipe(z.number().int().min(min, `має бути ≥ ${min}`).max(max, `має бути ≤ ${max}`))
      .optional(),
  ).transform((v) => v ?? def);

const envText = (def: string) =>
  z.preprocess(
    blankToUndef,
    z
      .string()
      .refine((s) => !s.includes('\0'), 'містить NUL-байт')
      .optional(),
  ).transform((v) => v ?? def);

const envFlag = (def: boolean) =>
  z.preprocess((v) => {
    if (v === '' || v === undefined) return undefined;
    const s = String(v).toLowerCase();
    if (['1', 'true', 'yes'].includes(s)) return true;
    if (['0', 'false', 'no'].includes(s)) return false;
    return v; // не впізнали → z.boolean() нижче дасть помилку
  }, z.boolean().optional()).transform((v) => v ?? def);

// Схема по ІМЕНАХ змінних оточення: так повідомлення про помилку містить
// саме "PORT"/"MAX_ROOMS", як у .env, а не внутрішнє camelCase-ім'я.
const EnvSchema = z.object({
  PORT: envInt(3000, 0, 65535),
  HOST: envText('127.0.0.1'),
  LOG_DIR: envText('./logs'),
  STATIC_DIR: envText('../client/dist'),
  MAX_ROOMS: envInt(20, 1, 1000),
  MAX_PLAYERS_PER_ROOM: envInt(8, 1, 64),
  RATE_LIMIT_PER_SEC: envInt(90, 1, 1000),
  MAX_PAYLOAD_BYTES: envInt(2048, 64, 1_048_576),
  JOIN_TIMEOUT_MS: envInt(5000, 10, 60_000),
  HEARTBEAT_MS: envInt(15_000, 10, 300_000),
  MAX_MISSED_PONGS: envInt(2, 1, 10),
  SLOW_CLIENT_BYTES: envInt(64 * 1024, 1024, 64 * 1024 * 1024),
  KILL_CLIENT_BYTES: envInt(1024 * 1024, 1024, 512 * 1024 * 1024),
  DEMO_ENDPOINTS: envFlag(false),
  SHUTDOWN_GRACE_MS: envInt(5000, 0, 60_000),
});

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logDir: string;
  readonly staticDir: string;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly rateLimitPerSec: number;
  readonly maxPayloadBytes: number;
  readonly joinTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly maxMissedPongs: number;
  readonly slowClientBytes: number;
  readonly killClientBytes: number;
  readonly demoEndpoints: boolean;
  readonly shutdownGraceMs: number;
}

export interface LoadConfigOptions {
  /** baseDir — відносно чого читати LOG_DIR/STATIC_DIR. */
  readonly baseDir?: string;
}

export function loadConfig(env: Env = process.env, { baseDir }: LoadConfigOptions = {}): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // усі проблеми разом, не по одній; шлях = ім'я змінної оточення
    const problems = parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`);
    throw new ConfigError(problems);
  }
  const d = parsed.data;

  if (d.KILL_CLIENT_BYTES <= d.SLOW_CLIENT_BYTES) {
    throw new ConfigError([
      `KILL_CLIENT_BYTES (${d.KILL_CLIENT_BYTES}) має бути більшим за SLOW_CLIENT_BYTES (${d.SLOW_CLIENT_BYTES})`,
    ]);
  }

  // Відносні шляхи рахуємо від каталогу запуску (cwd), якщо не задано інакше
  const base = baseDir ?? process.cwd();
  return Object.freeze({
    port: d.PORT,
    host: d.HOST,
    logDir: resolve(base, d.LOG_DIR),
    staticDir: resolve(base, d.STATIC_DIR),
    maxRooms: d.MAX_ROOMS,
    maxPlayersPerRoom: d.MAX_PLAYERS_PER_ROOM,
    rateLimitPerSec: d.RATE_LIMIT_PER_SEC,
    maxPayloadBytes: d.MAX_PAYLOAD_BYTES,
    joinTimeoutMs: d.JOIN_TIMEOUT_MS,
    heartbeatMs: d.HEARTBEAT_MS,
    maxMissedPongs: d.MAX_MISSED_PONGS,
    slowClientBytes: d.SLOW_CLIENT_BYTES,
    killClientBytes: d.KILL_CLIENT_BYTES,
    demoEndpoints: d.DEMO_ENDPOINTS,
    shutdownGraceMs: d.SHUTDOWN_GRACE_MS,
  });
}
