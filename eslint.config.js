import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['**/dist/**', '**/logs/**'],
  },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
  },
  {
    // Node-скрипти: тести, експерименти, конфіг Vite
    files: [
      'client/tests/**/*.js',
      'client/tools/**/*.{js,mjs}',
      'client/experiments/**/*.{js,mjs}',
      'client/vite.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // shared/: код, що крутиться і в браузері, і в Node. Тому тут немає ні
    // DOM, ні Node-глобалів (no-undef зловить `window`, `process`, `Buffer`…),
    // лише те, що є в обох: EventTarget і CustomEvent.
    files: ['shared/src/**/*.js'],
    languageOptions: {
      globals: { EventTarget: 'readonly', CustomEvent: 'readonly' },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'http', 'ws', 'url', 'os'],
              message: 'shared/ працює і в браузері: жодних модулів Node.',
            },
          ],
        },
      ],
    },
  },
  {
    // Детермінізм: ці API можуть давати різні результати в різних рушіях
    // (sin/cos/pow…) або в різний час (random, now). Замість них — math.js, rng.js.
    files: ['shared/src/sim/**/*.js', 'shared/src/scenario.js'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...[
          'random',
          'sin',
          'cos',
          'tan',
          'atan',
          'atan2',
          'exp',
          'log',
          'pow',
          'hypot',
        ].map((property) => ({
          object: 'Math',
          property,
          message: `Math.${property} недетермінований між рушіями або часом: використовуйте shared/src/math.js чи rng.js.`,
        })),
        {
          object: 'Date',
          property: 'now',
          message: 'Час не належить симуляції: передавайте dt.',
        },
        {
          object: 'performance',
          property: 'now',
          message: 'Час не належить симуляції: передавайте dt.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'BinaryExpression[operator="**"]',
          message: '`**` — це Math.pow: різні біти в різних рушіях.',
        },
      ],
    },
  },
  {
    files: [
      'shared/test/**/*.js',
      'shared/tools/**/*.{js,mjs}',
      'shared/experiments/**/*.{js,mjs}',
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Сервер: чистий Node, без DOM. Браузерних глобалів тут бути не повинно —
    // якщо в server/ випадково з'явиться `document` чи `window`, ESLint це покаже.
    files: ['server/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Шина подій розв'язує симуляцію зі звуком і HUD: sim може імпортувати
    // лише сусідні файли ('./x.js'), ніколи audio.js / hud.js / render.js.
    files: ['client/src/sim/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../*',
                '**/audio*',
                '**/hud*',
                '**/lobby*',
                '**/render*',
              ],
              message:
                'src/sim не повинен залежати від UI/звуку: повідомляйте через world.emit(...), а слухайте ззовні.',
            },
          ],
        },
      ],
    },
  },
];
