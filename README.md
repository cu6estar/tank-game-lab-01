# Tank Arena — Lab 01
окакккккк
Лабораторна робота 01 з JavaScript: Event Loop та Game Loop.

## Тема

2D-танк, який рухається по арені на Canvas 2D.

## Керування

- `W` — рух вперед
- `S` — рух назад
- `A` — поворот корпусу вліво
- `D` — поворот корпусу вправо
- `Q` — поворот башти вліво
- `E` — поворот башти вправо
- `Space` — підготовлено під стрільбу в наступних лабораторних

## Запуск

```bash
npm install
npm run dev
```

Після цього відкрити адресу, яку покаже Vite.

## Реалізовано

- Vite + Vanilla JavaScript
- ES-модулі
- `let` / `const`
- блочна область видимості
- closure у `createInput()`
- Canvas 2D API
- `devicePixelRatio`
- `requestAnimationFrame`
- fixed timestep: 60 simulation steps/s
- accumulator
- render interpolation
- HUD з FPS, steps/s та frame time
- чиста функція фізики `integrateTank()`
- wrapping країв арени

## Експерименти

Цей розділ треба заповнити після вимірювань для захисту.

### 1. Блокуючий цикл

Потрібно додати навмисний busy-wait приблизно на 100 ms та виміряти FPS/frame time.

**Результат:**

```text
FPS: ...
Frame time: ...
```

**Пояснення:**

JavaScript виконує код на main thread. Поки виконується блокуючий цикл, обробка інших задач та наступних callback `requestAnimationFrame` затримується.

### 2. setInterval замість requestAnimationFrame

Порівняти поведінку поточного game loop з варіантом на `setInterval`.

**Результат:**

```text
requestAnimationFrame:
FPS: ...
Frame time: ...

setInterval:
FPS: ...
Frame time: ...
```

**Пояснення:**

`requestAnimationFrame` синхронізований з оновленням кадру браузера, тоді як `setInterval` планує callback через timer queue і не є механізмом синхронізації з display refresh.

### 3. Variable timestep замість fixed timestep

Порівняти фізику при звичайному FPS та після throttling CPU.

**Результат:**

```text
Normal:
position = ...

CPU throttling:
position = ...
```

**Пояснення:**

При variable timestep результат фізики залежить від величини `dt`. Fixed timestep розділяє частоту симуляції та частоту рендерингу, тому симуляція залишається стабільною.

## Reflection

1. Чому `requestAnimationFrame` підходить для рендеру краще за `setInterval`?
2. Чому fixed timestep корисний для фізики?
3. Що відбувається з callback `requestAnimationFrame`, коли main thread заблокований?

## Git

Перед здачею:

```bash
git add .
git commit -m "Implement lab-01 tank game"
git tag lab-01
git push origin main
git push origin lab-01
```
