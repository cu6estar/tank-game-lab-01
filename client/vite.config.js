import { defineConfig } from 'vite';

// У розробці Vite віддає клієнт, а /api і /ws проксує на Node-сервер
// (server/, порт з SERVER_PORT, за замовчуванням 3000). У продакшені
// зібраний client/dist роздає сам сервер — одним origin, без CORS.
const serverPort = process.env.SERVER_PORT ?? '3000';
const target = `http://localhost:${serverPort}`;

export default defineConfig({
  // За замовчуванням Vite працює як SPA: будь-який невідомий URL (навіть
  // /assets/nope.png) отримує index.html зі статусом 200. Тоді fetch не бачить
  // 404, а спрайт "ламається" лише на декодуванні. 'mpa' вимикає цей fallback,
  // і відсутній файл дає справжній HTTP 404 (потрібно для екрана помилок).
  appType: 'mpa',
  server: {
    proxy: {
      '/api': target,
      '/health': target,
      '/ws': { target, ws: true },
    },
  },
});
