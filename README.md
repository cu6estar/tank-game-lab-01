# Tank Arena — Lab 01

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

### 1. Блокуючий цикл

Для експерименту було додано блокуючий цикл (`busy-wait`) приблизно на 100 мс.

**Результат:**

```text
FPS: 11
Frame time: 100.00 ms
```

**Пояснення:**

JavaScript виконує код на main thread. Поки виконується блокуючий цикл, main thread не може обробляти інші задачі та callback-и `requestAnimationFrame`. Через це збільшується час кадру та зменшується FPS.

---

### 2. setInterval замість requestAnimationFrame

Поточний game loop на `requestAnimationFrame` було тимчасово замінено на `setInterval` з інтервалом 16 мс.

**Результат:**

```text
requestAnimationFrame:
FPS: 180
Frame time: 5.56 ms

setInterval:
FPS: 62
Frame time: 15.00 ms
```

**Пояснення:**

`requestAnimationFrame` синхронізований з оновленням кадру браузера, тому на даній системі частота рендерингу становила приблизно 180 FPS. `setInterval` запускає callback через заданий інтервал, тому при значенні 16 мс частота була приблизно 62 FPS. При цьому fixed timestep симуляції залишався близько 60 кроків за секунду.

---

### 3. Variable timestep замість fixed timestep

Для експерименту fixed timestep було тимчасово замінено на variable timestep, при якому фізика отримує реальний `dt` між кадрами.

В обох випадках танк починав рух з однакової позиції, а час руху становив приблизно 12 секунд.

**Результат:**

```text
Normal:
position = x: 561.82, y: 500.00
time = 12.02 s

CPU throttling:
position = x: 560.58, y: 500.00
time = 12.03 s
```

**Пояснення:**

При variable timestep фізика отримує `dt`, який залежить від реального часу між кадрами. Тому кількість кроків симуляції залежить від FPS. У проведеному експерименті кінцева позиція танка при нормальній роботі та CPU throttling виявилася майже однаковою, але частота виконання фізики також становила близько 180 кроків за секунду.

Fixed timestep відокремлює частоту симуляції від частоти рендерингу. У поточній реалізації фізика виконується з фіксованим кроком `1/60` секунди, тому поведінка симуляції не залежить безпосередньо від FPS.


## Git

Перед здачею:

```bash
git add .
git commit -m "Implement lab-01 tank game"
git tag lab-01
git push origin main
git push origin lab-01
```
