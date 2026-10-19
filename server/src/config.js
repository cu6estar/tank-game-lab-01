import { resolve } from 'node:path';

/**
 * Уся конфігурація сервера — тут і лише тут. Решта коду не читає process.env:
 * вона отримує готовий, перевірений об'єкт. Тому помилка в .env видна одразу
 * при старті ("PORT має бути цілим 0–65535, отримано 'abc'"), а не через годину
 * як дивний збій десь у мережевому коді.
 *
 * Усі змінні необов'язкові (є розумні значення за замовчуванням), але якщо
 * змінну задано — вона мусить бути коректною.
 */
export class ConfigError extends Error {
  constructor(problems) {
    super(`Некоректна конфігурація:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const integer =
  (name, fallback, { min, max }) =>
  (env, problems) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;

    // Number('') === 0 і Number('12abc') — NaN: перевіряємо рядок, а не лише число
    if (!/^-?\d+$/.test(raw.trim())) {
      problems.push(`${name} має бути цілим числом, отримано "${raw}"`);
      return fallback;
    }
    const value = Number(raw);
    if (value < min || value > max) {
      problems.push(
        `${name} має бути в межах ${min}–${max}, отримано ${value}`,
      );
      return fallback;
    }
    return value;
  };

const text = (name, fallback) => (env, problems) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw.includes('\0')) problems.push(`${name} містить NUL-байт`);
  return raw;
};

const flag = (name, fallback) => (env, problems) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  problems.push(
    `${name} має бути 1/0, true/false або yes/no, отримано "${raw}"`,
  );
  return fallback;
};

const schema = {
  port: integer('PORT', 3000, { min: 0, max: 65535 }),
  host: text('HOST', '127.0.0.1'),
  logDir: text('LOG_DIR', './logs'),
  staticDir: text('STATIC_DIR', '../client/dist'),
  maxRooms: integer('MAX_ROOMS', 20, { min: 1, max: 1000 }),
  maxPlayersPerRoom: integer('MAX_PLAYERS_PER_ROOM', 8, { min: 1, max: 64 }),
  rateLimitPerSec: integer('RATE_LIMIT_PER_SEC', 20, { min: 1, max: 1000 }),
  maxPayloadBytes: integer('MAX_PAYLOAD_BYTES', 2048, {
    min: 64,
    max: 1_048_576,
  }),
  joinTimeoutMs: integer('JOIN_TIMEOUT_MS', 5000, { min: 10, max: 60_000 }),
  heartbeatMs: integer('HEARTBEAT_MS', 15_000, { min: 10, max: 300_000 }),
  maxMissedPongs: integer('MAX_MISSED_PONGS', 2, { min: 1, max: 10 }),
  slowClientBytes: integer('SLOW_CLIENT_BYTES', 64 * 1024, {
    min: 1024,
    max: 64 * 1024 * 1024,
  }),
  killClientBytes: integer('KILL_CLIENT_BYTES', 1024 * 1024, {
    min: 1024,
    max: 512 * 1024 * 1024,
  }),
  demoEndpoints: flag('DEMO_ENDPOINTS', false),
  shutdownGraceMs: integer('SHUTDOWN_GRACE_MS', 5000, { min: 0, max: 60_000 }),
};

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ baseDir?: string }} options baseDir — відносно чого читати LOG_DIR/STATIC_DIR
 */
export function loadConfig(env = process.env, { baseDir } = {}) {
  const problems = [];
  const config = {};
  for (const [key, read] of Object.entries(schema)) {
    config[key] = read(env, problems);
  }

  if (config.killClientBytes <= config.slowClientBytes) {
    problems.push(
      `KILL_CLIENT_BYTES (${config.killClientBytes}) має бути більшим за SLOW_CLIENT_BYTES (${config.slowClientBytes})`,
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);

  // Відносні шляхи рахуємо від каталогу запуску (cwd), якщо не задано інакше
  const base = baseDir ?? process.cwd();
  config.logDir = resolve(base, config.logDir);
  config.staticDir = resolve(base, config.staticDir);
  return Object.freeze(config);
}
