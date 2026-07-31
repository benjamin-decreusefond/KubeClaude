import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One config for the whole repository.
 *
 * The rules are chosen for what they catch rather than for how they look:
 * a floating promise in the queue, a `?? ''` that hides a real null, a hook
 * whose dependencies lie. Style is left to the diff — there is no formatter
 * here on purpose, and nothing in this file argues about quotes.
 *
 * Type-aware linting is on, which is what makes the promise and nullability
 * rules work at all; it costs a few seconds and finds things `tsc` does not.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'e2e/test-results/**',
      'e2e/playwright-report/**',
      'e2e/.tmp/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unhandled rejection in the queue or the scheduler is a run that
      // silently never finishes, which is the failure mode hardest to notice.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `_` marks a binding that is deliberately unused, most often a route
      // handler that takes a request it does not read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          // Destructuring a few fields off an object in order to drop them is
          // how several of these components build their payloads.
          ignoreRestSiblings: true,
        },
      ],
      // The codebase reads rows out of SQLite and messages off a JSON stream,
      // where `unknown` is honest and casting is how it gets narrowed.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Template literals over run ids, token counts and status strings are
      // exactly what the log lines are made of.
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },

  // The web workspace: a browser, JSX, and hooks whose dependency lists have to
  // be true or the UI goes stale in ways no test would catch.
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Node everywhere else.
  {
    files: ['server/**/*.ts', 'e2e/**/*.ts', '*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // This config file, and anything else plain JavaScript, is outside every
  // tsconfig and so outside type-aware linting.
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      // Spread first: a bare `languageOptions` here would drop the parser
      // settings that turn type-aware linting off, and the parse would fail.
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },

  // The stub CLI stands in for a program that writes to stdout; that is its job.
  {
    files: ['server/test/fixtures/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off', '@typescript-eslint/no-unused-vars': 'off' },
  },

  // Tests reach into internals on purpose, and a non-null assertion in a test
  // is a claim the test itself would fail on if it were wrong.
  {
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts', 'server/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // `test()` from node:test returns a promise that nobody is meant to
      // await; the runner is what waits for it.
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
);
