import js from '@eslint/js';
import globals from 'globals';
import typescript from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
  {
    // The `src/generated` trees below are Speckify's output, committed as
    // generated and never edited by hand (see scripts/assert-contracts-generated.py).
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/bin',
      'graphify-out',
      'services/broker/src/generated',
      'services/provisioning-controller/src/generated',
    ],
  },
  {
    files: ['**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescript.parser,
    },
    plugins: {
      '@typescript-eslint': typescript.plugin,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      // Base no-unused-vars (from js.configs.recommended above) doesn't
      // understand TS-only constructs like named parameters in function
      // type signatures — @typescript-eslint's version replaces it correctly.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  prettier,
];
