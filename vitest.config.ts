import { defineConfig } from 'vitest/config';

// Монорепо: три проєкти (shared / client / server) зі своїми vitest.config.ts.
// Покриття рахуємо лише для shared/src — вимога лаби ≥85 %.
export default defineConfig({
  test: {
    projects: ['shared', 'client', 'server'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['shared/src/**/*.ts'],
      // лише типи (жодного рантайму) — у звіті вони дають оманливі 0 %
      exclude: ['shared/src/**/*.d.ts', 'shared/src/protocol/types.ts', 'shared/src/sim/entities.ts'],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 80,
      },
    },
  },
});
