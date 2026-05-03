import nextConfig from 'eslint-config-next'

export default [
  ...nextConfig,
  {
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
    ignores: ['contracts/**', 'ios/**', 'android/**', 'public/sw.js'],
  },
]
