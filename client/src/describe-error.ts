/**
 * Людський опис помилки для екрана завантаження та лобі. Повертає { title, detail }.
 * Розрізняємо за `error.name`, бо instanceof ламається між модулями/вікнами.
 */
export interface ErrorDescription {
  title: string;
  detail: string;
}

// Помилки завантаження мають додаткові поля (status, url); дивимось на них безпечно.
function field(error: unknown, key: string): unknown {
  // as Record: читаємо довільне поле невідомого об'єкта-помилки (одне місце)
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

export function describeError(error: unknown): ErrorDescription {
  const name = field(error, 'name');
  const status = Number(field(error, 'status'));
  const url = String(field(error, 'url') ?? '');
  const message = String(field(error, 'message') ?? error);

  switch (name) {
    case 'HttpError':
      return status >= 500
        ? { title: `Сервер недоступний (HTTP ${status})`, detail: `${url} — спробуйте ще раз трохи згодом.` }
        : { title: `Файл не знайдено або заборонено (HTTP ${status})`, detail: `${url} — повторювати марно, це помилка запиту.` };
    case 'TimeoutError':
      return { title: 'Сервер не відповів вчасно', detail: "Перевірте з'єднання й повторіть спробу." };
    case 'AbortError':
      return { title: 'Завантаження скасовано', detail: 'Ви можете запустити його знову.' };
    case 'BadJsonError':
      return { title: 'Сервер повернув пошкоджені дані', detail: `${url} — відповідь не є коректним JSON.` };
    case 'DecodeError':
      return { title: 'Файл пошкоджений', detail: `${url} — браузер не зміг його декодувати.` };
    case 'ManifestError':
      return { title: 'Некоректний маніфест ассетів', detail: message };
    case 'TypeError':
      return { title: "Немає зв'язку з сервером", detail: 'Мережа недоступна або сервер не запущено.' };
    default:
      return { title: 'Щось пішло не так', detail: message };
  }
}
