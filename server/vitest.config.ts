import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // інтеграційні тести піднімають справжні сервери/процеси — даємо запас часу
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
