import { defineConfig, devices } from '@playwright/test';

// E2E: піднімаємо справжній сервер (build клієнта + Node) і ганяємо два
// браузери в одній кімнаті. Браузер у sandbox потребує --no-sandbox.
const PORT = process.env.E2E_PORT ?? '3100';
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE,
    headless: true,
    launchOptions: { args: ['--no-sandbox'] },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm start',
    url: `${BASE}/health`,
    env: { PORT, HOST: '127.0.0.1' },
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
