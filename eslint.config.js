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
      'client/experiments/**/*.{js,mjs}',
      'client/vite.config.js',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Сервер: чистий Node, без DOM. Браузерних глобалів тут бути не повинно —
    // якщо в server/ випадково з'явиться `document` чи `window`, ESLint це покаже.
    files: ['server/**/*.js'],
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
