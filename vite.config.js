import { defineConfig } from 'vite';

/**
 * Лобі ходить за GET /api/rooms. Справжнього сервера ще немає (його напише
 * лабораторна 4), тому /api/rooms віддає статичний public/api/rooms.json.
 * Працює і в `vite` (dev), і в `vite preview` (збірка).
 */
function roomsApi() {
  const rewrite = (req, res, next) => {
    const [path, query] = (req.url ?? '').split('?');
    if (path === '/api/rooms') {
      req.url = `/api/rooms.json${query ? `?${query}` : ''}`;
    }
    next();
  };

  return {
    name: 'rooms-api',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

export default defineConfig({
  // За замовчуванням Vite працює як SPA: будь-який невідомий URL (навіть
  // /assets/nope.png) отримує index.html зі статусом 200. Тоді fetch не бачить
  // 404, а спрайт "ламається" лише на декодуванні. 'mpa' вимикає цей fallback,
  // і відсутній файл дає справжній HTTP 404 (потрібно для екрана помилок).
  appType: 'mpa',
  plugins: [roomsApi()],
});
