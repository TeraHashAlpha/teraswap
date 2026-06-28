import { defineConfig, devices } from '@playwright/test'

/**
 * Real-render (Chromium) tests — proving what JSDOM cannot: layout, overflow,
 * scrolling, and pointer/wheel input. [chore/category-scroll-fix]
 *
 * Test files are named `*.pw.ts` so vitest's `*.test.ts(x)` discovery never picks
 * them up (and vice-versa). The harness is built in `globalSetup` (esbuild bundle of
 * the REAL component + the app's compiled Tailwind CSS) and loaded via file:// — no
 * dev server, no network, no env/secrets, so it is deterministic in CI.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.ts',
  globalSetup: './e2e/category-chips/build.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line']] : [['list']],
  use: {
    ...devices['Desktop Chrome'], // desktop mouse context (the bug's environment)
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
