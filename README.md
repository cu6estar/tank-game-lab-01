# Tank Arena — Lab 03

Лабораторна 03: **асинхронний JavaScript — Promises, `async/await` і екран завантаження**.

Гра з lab-01/02 тепер стартує не одразу: спершу завантажуються спрайти й звуки (з прогрес-баром), потім гравець бачить лобі з кімнатами, обирає одну — і лише тоді починається гра. Нотатки попередніх лаб: [docs/lab-01.md](docs/lab-01.md), [docs/lab-02.md](docs/lab-02.md).

## Запуск

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 73 тести (node:test)
npm run lint
npm run build
```

Експерименти: `npm run exp:timing`, `npm run exp:puzzles`, `npm run exp:failures`.

Керування: `↑↓←→` рух, `Z/X` башта, `Space` постріл, `M` звук, `Esc` назад у лобі.

## Потік гри

```text
boot → завантаження (прогрес-бар) → лобі (GET /api/rooms, опитування) → гра → Esc → лобі
            │ помилка → екран помилки + «Повторити»      │ помилка → статус + «Повторити»
```

## Що де лежить

```text
public/assets/manifest.json     список ассетів (key, type, url, optional)
public/assets/sprites.{png,json}   атлас спрайтів + прив'язки (pivot)
public/assets/*.wav             shoot / hit / explosion
public/api/rooms.json           «сервер» лобі (Vite віддає як /api/rooms)
src/assets/loader.js            fetchJson, withRetry, loadImage/Audio/Json, loadAll
src/loading-screen.js           екран завантаження (canvas-прогрес-бар)
src/lobby.js                    class Lobby extends EventTarget (логіка)
src/lobby-ui.js                 DOM лобі (окремо від логіки)
src/audio.js, src/hud.js        підписники на події симуляції
src/sim/*                       симуляція; НЕ імпортує audio/hud
src/dev/chaos.js                ?chaos=… — навмисні збої для перевірки
tools/generate-assets.py        детермінований генератор спрайтів і звуків
```

## M1. Завантажувач

- Усі завантажувачі приймають `AbortSignal`: `loadJson`, `loadImage`, `loadAudio`.
- Спільний `fetchJson`/`fetchChecked` **перевіряє `response.ok`**: `fetch` не кидає помилку на 404/500, тож без цього «успіхом» вважався б HTML зі сторінкою помилки.
- `withRetry`: експоненційний backoff з повним jitter, `delay = random() × min(maxMs, baseMs × 2^(спроба−1))` (jitter — щоб клієнти не повторювали запити синхронно).
- **Що ретраїмо:** 5xx, мережеву помилку (`TypeError`), таймаут. **Не ретраїмо:** 4xx (файл не з'явиться від повтору), битий JSON, помилку декодування, скасування користувачем.
- `loadAll` — `Promise.all` з прогресом по кожному файлу. `Promise.all` **не скасовує** сусідів при першій відмові, тому `loadAll` сам абортить спільний `AbortController`, щоб решта не качалась даремно.
- Звуки в маніфесті `optional` — їхня відсутність не валить гру (HUD чесно пише «гра без звуку»).
- Гра стартує лише після `await loadAll(...)`; прогрес-бар малюється на справжньому `<canvas>` за реальною часткою завершених файлів.

### Sequential `await` vs concurrent `Promise.all`

`npm run exp:timing` — ті самі 5 файлів з локального сервера з затримкою 200 мс на файл:

| стратегія                 | час         | пояснення                |
| ------------------------- | ----------- | ------------------------ |
| `for … await` по черзі    | **1057 мс** | сума затримок: 5 × 200   |
| `loadAll` (`Promise.all`) | **213 мс**  | максимум затримок: ≈ 200 |

Прискорення ×5 = кількості файлів. Мережа чекає паралельно, а sequential-цикл простоює між запитами. (Ліміт ~6 з'єднань на хост у HTTP/1.1 обмежив би виграш при десятках файлів — у нас їх 5.)

## M2. Спрайти, звук, події

- Кораблі, кулі й астероїди малюються `drawImage` з **вирізкою зі спрайт-листа** (`sx, sy, sw, sh`) і pivot-ом з `sprites.json`; поворот — навколо pivot.
- Звук — **Web Audio**: один `AudioContext`, створений «suspended»; `resume()` викликається першим жестом (клік/клавіша/Join). Буфери декодуються (`decodeAudioData`) ще на екрані завантаження. Кожен постріл — новий дешевий `AudioBufferSourceNode`, тож постріли накладаються.
- Симуляція **не імпортує** `audio.js` і `hud.js` (правило ESLint `no-restricted-imports` для `src/sim`). `World` — `EventTarget`, що диспатчить `CustomEvent`: `fired`, `hit`, `exploded` (+ `pickup`); `Game` додає `scoreChanged`. `audio.bind(world)` і `hud.bindGame(game)` просто підписуються.

## M3. Лобі

- `GET /api/rooms` — статичний `public/api/rooms.json`, Vite віддає його під цією адресою (`vite.config.js`, плагін-middleware).
- `class Lobby extends EventTarget` — `refresh()`, `join(roomId)`, подія `roomsChanged`. DOM-код у окремому `lobby-ui.js`: логіку можна тестувати без браузера.
- Поки лобі видиме, список оновлюється кожні 4 с; у грі опитування зупиняється, після `Esc` — відновлюється.
- Кожен запит має `AbortSignal.timeout`; при виході з лобі/старті гри запит скасовується.
- Помилки: 404/500/таймаут/битий JSON → зрозуміле повідомлення + кнопка «Повторити»; заповнена кімната недоступна для вибору.

## M4. Головоломки: мікрозадачі проти задач

Усі п'ять придумані мною; вивід **записаний у коді й перевіряється запуском** (`npm run exp:puzzles`; п'ята — у Chromium).

**1. `await` ріже функцію навпіл**

```js
async function load() {
  log('A');
  await null;
  log('C');
}
load();
Promise.resolve().then(() => log('E'));
log('B');
log('D');
```

Вивід: `A B D C E`. Тіло async-функції біжить синхронно до першого `await`; решта — мікрозадача, що стала в чергу раніше за пізніший `.then`.

**2. `setTimeout` усередині `.then`**

```js
log('start');
setTimeout(() => log('timeout 0'), 0);
Promise.resolve()
  .then(() => {
    log('then 1');
    setTimeout(() => log('timeout in then'), 0);
  })
  .then(() => log('then 2'));
log('sync end');
```

Вивід: `start sync end then 1 then 2 timeout 0 timeout in then`. Усі мікрозадачі виконуються до першого таймера; таймери — у порядку створення.

**3. `return Promise` з async-функції коштує зайві тики**

```js
async function viaReturn() {
  return Promise.resolve('async result');
}
viaReturn().then(log);
Promise.resolve()
  .then(() => log('p'))
  .then(() => log('q'))
  .then(() => log('r'));
log('sync');
```

Вивід: `sync p q async result r`. Проміс-обгортка чекає на thenable ще кілька тиків, тож `p→q` встигають раніше, а `r` — після.

**4. `catch → finally → then`, таймер останній**

```js
Promise.reject(new Error('boom'))
  .then(() => log('SKIPPED'))
  .catch(() => log('2 catch'))
  .finally(() => log('3 finally'))
  .then(() => log('4 after finally'));
setTimeout(() => log('5 timeout'), 0);
log('1');
```

Вивід: `1 2 catch 3 finally 4 after finally 5 timeout`. Відмова проскакує повз `then`, `catch` її «лікує», `finally` значення не змінює; усе це мікрозадачі — таймер у кінці.

**5. `requestAnimationFrame` ([experiments/puzzle-raf.html](experiments/puzzle-raf.html))**

```js
requestAnimationFrame(() => {
  log('raf 1');
  Promise.resolve().then(() => log('micro (з raf 1)'));
});
requestAnimationFrame(() => log('raf 2'));
Promise.resolve().then(() => log('micro (sync)'));
log('sync');
```

Вивід (Chromium): `sync micro (sync) raf 1 micro (з raf 1) raf 2`. Мікрозадачі виконуються після **кожного** колбека, тому між `raf 1` і `raf 2` встигає `micro`.

## M4. Галерея збоїв

Гра не падає, не стартує зламаною і завжди пропонує вихід. У браузері збої відтворюються `?chaos=…` (див. `src/dev/chaos.js`), у Node — `npm run exp:failures`.

| Збій                       | Що бачить гравець                                            | Мережа / поведінка                              | Скриншот                                                |
| -------------------------- | ------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------- |
| 404 спрайта                | екран помилки + «Повторити»                                  | **1 запит**, без ретраїв (`?chaos=sprite404:1`) | [failure-1](docs/screenshots/failure-1-sprite-404.png)  |
| 404 звуку (optional)       | гра стартує, у HUD «без звуку»                               | не валить завантаження                          | [failure-1b](docs/screenshots/failure-1b-audio-404.png) |
| таймаут `/api/rooms`       | «сервер не відповів вчасно» + «Повторити», потім саме одужує | `AbortSignal.timeout`                           | [failure-2](docs/screenshots/failure-2-timeout.png)     |
| abort посеред завантаження | екран «скасовано» + «Повторити»                              | запити скасовані, гра не стартує сама           | [failure-3](docs/screenshots/failure-3-abort.png)       |
| битий JSON                 | «пошкоджені дані»; для атласу — екран помилки                | **1 запит**, не ретраїмо                        | [failure-4](docs/screenshots/failure-4-bad-json.png)    |
| 503 (нестабільний сервер)  | прогрес повільно йде вперед                                  | ретраї з backoff, 10 ретраїв на 5 файлів, ~2 с  | [failure-5](docs/screenshots/failure-5-flaky-retry.png) |

Усі 8 сценаріїв пройшли у справжньому Chromium (Playwright): без необроблених винятків.

## Захист: Reflection

1. **Чому `fetch` не кидає помилку на 404?** Проміс відхиляється лише при мережевому збої; HTTP-відповідь — теж успіх транспорту. Тому `ok` перевіряємо самі.
2. **Чому `Promise.all` не скасовує решту при відмові?** Проміси не скасовуються — лише результат. Скасування — окремий механізм (`AbortController`), тому `loadAll` абортить спільний сигнал.
3. **Чому retry без jitter шкодить?** Усі клієнти після збою повторюють запит в один момент і знову перевантажують сервер; jitter розмазує їх у часі.

## Теги

Тег: `lab-03`.
