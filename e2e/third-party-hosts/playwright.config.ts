import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * [fix/user-ip-privacy] Third-party-host capture: what does the BROWSER contact?
 *
 * Real Chromium against a PRODUCTION build, with the site's REAL Content-Security-Policy (no bypassCSP), for v1 and v2
 * on Ethereum / Base / Arbitrum. Every request that is not the app's own origin is recorded and answered locally — nothing
 * leaves the machine — and the run fails on any host outside the allow-list (allow-list.ts). With no wallet that list is
 * empty: a visitor's browser talks to our origin and nobody else.
 *
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<any 32 chars> npm run build        # once (see .github/workflows/e2e.yml for the CI env)
 *   npx playwright test --config e2e/third-party-hosts/playwright.config.ts  # starts the RPC stub + `next start` ×2 itself
 *
 * Two servers from ONE build: `UI_V2_ENABLED` is read per request by src/proxy.ts, so v1 and v2 differ only by that env.
 * `CAPTURE_V1_URL` / `CAPTURE_V2_URL` point the run at servers you already started (used for the before/after table);
 * `CAPTURE_OUT` is a directory that receives one JSON report per run.
 */
const REPO_ROOT = resolve(__dirname, '../..')
const APP_DIR = process.env.CAPTURE_APP_DIR ? resolve(process.env.CAPTURE_APP_DIR) : REPO_ROOT
export const RPC_STUB_PORT = 3930
export const V1_PORT = 3931
export const V2_PORT = 3932

export const V1_URL = process.env.CAPTURE_V1_URL ?? `http://127.0.0.1:${V1_PORT}`
export const V2_URL = process.env.CAPTURE_V2_URL ?? `http://127.0.0.1:${V2_PORT}`

/** The proxy's upstreams during the run: the local stub, one path per chain. Server-only names (rpc-env.ts). */
const SERVER_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  RPC_URL_1: `http://127.0.0.1:${RPC_STUB_PORT}/1`,
  RPC_URL_8453: `http://127.0.0.1:${RPC_STUB_PORT}/8453`,
  RPC_URL_42161: `http://127.0.0.1:${RPC_STUB_PORT}/42161`,
}

const external = Boolean(process.env.CAPTURE_V1_URL || process.env.CAPTURE_V2_URL)

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // The real CSP is part of what is under test: never bypass it here.
    bypassCSP: false,
    // Every request must be observable from the page: a controlling service worker would proxy them out of reach.
    serviceWorkers: 'block',
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
  },
  webServer: external
    ? [{ command: `node ${resolve(__dirname, 'rpc-stub.mjs')} ${RPC_STUB_PORT}`, url: `http://127.0.0.1:${RPC_STUB_PORT}`, reuseExistingServer: true, timeout: 30_000 }]
    : [
        { command: `node ${resolve(__dirname, 'rpc-stub.mjs')} ${RPC_STUB_PORT}`, url: `http://127.0.0.1:${RPC_STUB_PORT}`, reuseExistingServer: true, timeout: 30_000 },
        { command: `npx next start -p ${V1_PORT}`, cwd: APP_DIR, url: V1_URL, reuseExistingServer: true, timeout: 120_000, env: { ...SERVER_ENV, UI_V2_ENABLED: '' } },
        { command: `npx next start -p ${V2_PORT}`, cwd: APP_DIR, url: V2_URL, reuseExistingServer: true, timeout: 120_000, env: { ...SERVER_ENV, UI_V2_ENABLED: 'true' } },
      ],
})
