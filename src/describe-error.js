/**
 * Людський опис помилки для екрана завантаження та лобі.
 * Повертає { title, detail }: що сталося і що з цим можна зробити.
 * Розрізняємо за `error.name`, бо instanceof ламається між модулями/вікнами.
 */
export function describeError(error) {
  switch (error?.name) {
    case 'HttpError':
      return error.status >= 500
        ? {
            title: `Сервер недоступний (HTTP ${error.status})`,
            detail: `${error.url} — спробуйте ще раз трохи згодом.`,
          }
        : {
            title: `Файл не знайдено або заборонено (HTTP ${error.status})`,
            detail: `${error.url} — повторювати марно, це помилка запиту.`,
          };

    case 'TimeoutError':
      return {
        title: 'Сервер не відповів вчасно',
        detail: "Перевірте з'єднання й повторіть спробу.",
      };

    case 'AbortError':
      return {
        title: 'Завантаження скасовано',
        detail: 'Ви можете запустити його знову.',
      };

    case 'BadJsonError':
      return {
        title: 'Сервер повернув пошкоджені дані',
        detail: `${error.url} — відповідь не є коректним JSON.`,
      };

    case 'DecodeError':
      return {
        title: 'Файл пошкоджений',
        detail: `${error.url} — браузер не зміг його декодувати.`,
      };

    case 'ManifestError':
      return { title: 'Некоректний маніфест ассетів', detail: error.message };

    case 'TypeError':
      return {
        title: "Немає зв'язку з сервером",
        detail: 'Мережа недоступна або сервер не запущено.',
      };

    default:
      return {
        title: 'Щось пішло не так',
        detail: String(error?.message ?? error),
      };
  }
}
