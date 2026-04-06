import nextConfig from 'eslint-config-next'

export default [
  ...nextConfig,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    ignores: ['contracts/**', 'ios/**', 'android/**', 'public/sw.js'],
  },
]
