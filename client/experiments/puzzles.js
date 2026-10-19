// П'ять власних головоломок про чергу мікрозадач і чергу задач.
// Для кожної: код, вивід і пояснення в одному рядку. Скрипт запускає їх і
// порівнює фактичний вивід із записаним тут, тож README не бреше.
// Головоломка 5 (requestAnimationFrame) — у браузері: experiments/puzzle-raf.html.
// Запуск: npm run exp:puzzles
const puzzles = [];
const puzzle = (title, why, expected, run) =>
  puzzles.push({ title, why, expected, run });
const idle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

puzzle(
  '1. await ріже функцію навпіл',
  'тіло async-функції біжить синхронно до першого await; решта — мікрозадача, яка стає в чергу раніше за пізніший .then',
  ['A', 'B', 'D', 'C', 'E'],
  async (log) => {
    async function load() {
      log('A');
      await null;
      log('C');
    }
    load();
    Promise.resolve().then(() => log('E'));
    log('B');
    log('D');
    await idle();
  },
);

puzzle(
  '2. setTimeout всередині .then',
  'усі мікрозадачі (then 1, then 2) виконуються до першого таймера; таймери йдуть у порядку створення',
  ['start', 'sync end', 'then 1', 'then 2', 'timeout 0', 'timeout in then'],
  async (log) => {
    log('start');
    setTimeout(() => log('timeout 0'), 0);
    Promise.resolve()
      .then(() => {
        log('then 1');
        setTimeout(() => log('timeout in then'), 0);
      })
      .then(() => log('then 2'));
    log('sync end');
    await idle();
  },
);

puzzle(
  '3. return Promise з async-функції коштує зайві тики',
  'return проміса з async-функції додає тики (обгортка чекає на thenable), тож p→q встигають до результату, а r — після',
  ['sync', 'p', 'q', 'async result', 'r'],
  async (log) => {
    async function viaReturn() {
      return Promise.resolve('async result');
    }
    viaReturn().then(log);
    Promise.resolve()
      .then(() => log('p'))
      .then(() => log('q'))
      .then(() => log('r'));
    log('sync');
    await idle();
  },
);

puzzle(
  '4. catch → finally → then, і таймер останній',
  'відмова проскакує повз then, catch її "лікує", finally значення не змінює; усе це мікрозадачі, тож таймер у самому кінці',
  ['1', '2 catch', '3 finally', '4 after finally', '5 timeout'],
  async (log) => {
    Promise.reject(new Error('boom'))
      .then(() => log('SKIPPED'))
      .catch(() => log('2 catch'))
      .finally(() => log('3 finally'))
      .then(() => log('4 after finally'));
    setTimeout(() => log('5 timeout'), 0);
    log('1');
    await idle();
  },
);

let failed = 0;
for (const { title, why, expected, run } of puzzles) {
  const lines = [];
  await run((line) => lines.push(String(line)));
  const ok = JSON.stringify(lines) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? '✔' : '✘'} ${title}`);
  console.log(`   вивід:  ${lines.join(' → ')}`);
  console.log(`   чому:   ${why}`);
  if (!ok) console.log(`   очікував: ${expected.join(' → ')}`);
}
console.log(
  '\n5. див. experiments/puzzle-raf.html (requestAnimationFrame, потрібен браузер)',
);
process.exitCode = failed ? 1 : 0;
