import nextConfig from 'eslint-config-next'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default [
  ...nextConfig,
  {
    // `.mts` / `.cts` (and so `.d.mts` / `.d.cts`) are TypeScript too. eslint-config-next's TypeScript block matches only
    // `*.ts` / `*.tsx`, which left them on its Babel parser; on Babel's function-type nodes
    // @typescript-eslint/no-unused-vars throws `node.params is not iterable` and eslint exits 2 (PR #727).
    // Same parser and parser options as that block; the rules below already apply to every extension.
    // scripts/eslint-mts.test.mjs pins it.
    files: ['**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module' },
    },
  },
  {
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      // eslint-config-next 16.2.4 promoted these React Compiler advisory
      // rules from "warn" to "error". They flag pre-existing patterns
      // (setState-in-effect, impure-during-render, etc.) that need
      // separate refactor passes. Keep them visible at "warn" until
      // that refactor lands so chore/security patches aren't blocked.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/use-memo': 'warn',
    },
  },
  {
    ignores: ['contracts/**', 'public/sw.js'],
  },
]
