import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**'],
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
    files: ['tests/**/*.js', 'experiments/**/*.{js,mjs}', 'vite.config.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // Шина подій розв'язує симуляцію зі звуком і HUD: sim може імпортувати
    // лише сусідні файли ('./x.js'), ніколи audio.js / hud.js / render.js.
    files: ['src/sim/**/*.js'],
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
