import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    // [P115/M-01] Default environment is node — fast, no DOM overhead.
    // React hook + component tests that need a DOM declare
    // `// @vitest-environment jsdom` at the top of their file so we
    // don't penalise the pure-logic suite with a JSDOM bootstrap.
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      '__tests__/**/*.test.ts',
      '__tests__/**/*.test.tsx',
      // [CHORE-TOKEN-CATALOG-PIPELINE] build-time catalog pipeline logic is pure + unit-tested.
      'scripts/token-catalog/**/*.test.ts',
      // [CHORE-GROK-DISPATCH] repo-hygiene scripts get the same coverage as source.
      'scripts/*.test.mjs',
    ],
    // jsdom shim for tests that touch `localStorage`/`window` via the
    // jsdom env. happy-dom would be faster but jsdom has wider parity
    // with libraries like @testing-library/react.
    setupFiles: ['./src/test-utils/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/alert-wrapper.ts', 'src/lib/alert-channels/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
