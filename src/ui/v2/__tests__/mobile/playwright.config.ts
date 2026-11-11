import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

// [L-8, A75] `npx next start` must run from the REPO ROOT (where package.json / .next live), not from this
// config file's own directory (Playwright's default webServer cwd) — the documented command is run from an
// arbitrary shell, not necessarily one already cd'd to the root.
const REPO_ROOT = resolve(__dirname, '../../../../..')

/**
 * [feat/ui-v2-mobile-parity] Real-render gates for the v2 shell at 375 (and the 1440 desktop shots). Layout does not exist in jsdom, so
 * overflow / tap-target / sticky-CTA / bottom-sheet checks run in real Chromium against a PRODUCTION server:
 *
 *   UI_V2_ENABLED=true NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<any 32 chars> npm run build   # once
 *   npx playwright test --config src/ui/v2/__tests__/mobile/playwright.config.ts            # starts `next start` itself
 *
 * `V2_BASE_URL` points it at a server you already run; `V2_SHOTS_DIR` writes the 375 / 1440 screenshot of every route.
 * [L-8, A75] Wired into `.github/workflows/e2e.yml`'s `v2-mobile-parity` job (own job: it needs a real build +
 * server, unlike the isolated-harness job above it).
 */
const PORT = 3917
const baseURL = process.env.V2_BASE_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: { baseURL, ...devices['Desktop Chrome'], bypassCSP: true /* rig.ts stubs every off-origin request; the CSP itself is exercised by e2e/third-party-hosts */, launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined } },
  webServer: process.env.V2_BASE_URL
    ? undefined
    : { command: `npx next start -p ${PORT}`, cwd: REPO_ROOT, url: baseURL, reuseExistingServer: true, timeout: 120_000, env: { UI_V2_ENABLED: 'true', NEXT_TELEMETRY_DISABLED: '1' } },
})
