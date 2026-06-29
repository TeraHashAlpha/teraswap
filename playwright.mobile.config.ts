import { defineConfig, devices } from '@playwright/test'

/**
 * [chore/mobile-ux-polish] Real-render (Chromium) MOBILE-viewport tests — proving what JSDOM cannot:
 * the mode tab bar genuinely scrolls (no flex-1 squish), tap targets are ≥44px, labels ≥12px, the
 * last tab is reachable, and nothing overflows the viewport at iPhone SE / iPhone 14 / Pixel 7.
 *
 * Separate from playwright.config.ts (the desktop category-chips suite) so each keeps its own
 * globalSetup + device projects. Harness is built in globalSetup (esbuild + tailwind CLI) and loaded
 * via file:// — no dev server, no env. Run: `npm run test:e2e:mobile`.
 */
export default defineConfig({
  testDir: './e2e/mobile',
  testMatch: '**/*.pw.ts',
  globalSetup: './e2e/mobile/build.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  // Device VIEWPORT emulation on Chromium (the cached/CI browser). The iPhone descriptors default to
  // WebKit; we keep their mobile viewport/UA/touch but force Chromium so the suite is deterministic
  // without a separate WebKit install. (Pixel 7 is already Chromium.)
  projects: [
    { name: 'iphone-se', use: { ...devices['iPhone SE'], browserName: 'chromium' } },
    { name: 'iphone-14', use: { ...devices['iPhone 14'], browserName: 'chromium' } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'] } },
  ],
})
