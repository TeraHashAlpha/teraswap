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
  // Scoped to the category-chips suite only — the mobile suite (e2e/mobile) has its OWN config +
  // globalSetup (playwright.mobile.config.ts), so the default `test:e2e` run must not pick it up
  // (it builds a different harness). [chore/mobile-ux-polish]
  testDir: './e2e/category-chips',
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
