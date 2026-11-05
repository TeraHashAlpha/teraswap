import { defineConfig, devices } from '@playwright/test'

/**
 * [feat/ui-v2-mobile-parity] Real-render gates for the v2 shell at 375 (and the 1440 desktop shots). Layout does not exist in jsdom, so
 * overflow / tap-target / sticky-CTA / bottom-sheet checks run in real Chromium against a PRODUCTION server:
 *
 *   UI_V2_ENABLED=true NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<any 32 chars> npm run build   # once
 *   npx playwright test --config src/ui/v2/__tests__/mobile/playwright.config.ts            # starts `next start` itself
 *
 * `V2_BASE_URL` points it at a server you already run; `V2_SHOTS_DIR` writes the 375 / 1440 screenshot of every route. This suite is NOT in
 * the repo's CI workflows (`.github/` is outside this slice's diff scope) — wiring it into e2e.yml is the follow-up.
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
  use: { baseURL, ...devices['Desktop Chrome'], bypassCSP: true /* the L2 RPC hosts the CSP would refuse are stubbed in rig.ts */, launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined } },
  webServer: process.env.V2_BASE_URL
    ? undefined
    : { command: `npx next start -p ${PORT}`, url: baseURL, reuseExistingServer: true, timeout: 120_000, env: { UI_V2_ENABLED: 'true', NEXT_TELEMETRY_DISABLED: '1' } },
})
