import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * [fix/mainnet-rpc-out-of-client, SEC-5] A normal MAINNET session in a real browser, v1 and v2, wallet connected, every
 * read through the REAL `/api/rpc` route handler. LOCAL ONLY (owner, 2026-11-17): no CI workflow runs this config.
 *
 *   # once: a production build. Give it marker values for the retired names so the run also proves the browser never
 *   # contacts them (.github/workflows/e2e.yml third-party-hosts uses the same markers):
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=00000000000000000000000000000000 \
 *   NEXT_PUBLIC_RPC_URL=https://mainnet-provider.invalid/v2/CAPTURE-MARKER-MAINNET-RPC-KEY npm run build
 *   npx playwright test --config e2e/mainnet-rpc-session/playwright.config.ts   # starts `next start` x2 itself
 *
 * `/api/rpc`'s upstream (RPC_URL_1) is an ABI-aware JSON-RPC stub the spec starts on UPSTREAM_PORT, answering like the
 * CoW capture (e2e/third-party-hosts/cow-flow.ts). `SESSION_OUT` is a directory that receives one JSON report per UI.
 * Same CSP, service-worker and capture discipline as e2e/third-party-hosts (see its playwright.config.ts).
 */
const REPO_ROOT = resolve(__dirname, '../..')
const APP_DIR = process.env.CAPTURE_APP_DIR ? resolve(process.env.CAPTURE_APP_DIR) : REPO_ROOT
export const UPSTREAM_PORT = 3943
export const V1_PORT = 3941
export const V2_PORT = 3942
export const V1_URL = `http://127.0.0.1:${V1_PORT}`
export const V2_URL = `http://127.0.0.1:${V2_PORT}`

/** Server-only names (rpc-env.ts). Only RPC_URL_1 matters here; the L2 names point at the same stub so nothing dials out. */
const SERVER_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  RPC_URL_1: `http://127.0.0.1:${UPSTREAM_PORT}/1`,
  RPC_URL_8453: `http://127.0.0.1:${UPSTREAM_PORT}/8453`,
  RPC_URL_42161: `http://127.0.0.1:${UPSTREAM_PORT}/42161`,
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.pw.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    bypassCSP: false,
    serviceWorkers: 'block',
    launchOptions: { executablePath: process.env.PW_CHROMIUM || undefined },
  },
  webServer: [
    { command: `npx next start -p ${V1_PORT}`, cwd: APP_DIR, url: V1_URL, reuseExistingServer: false, timeout: 120_000, env: { ...SERVER_ENV, UI_V2_ENABLED: '' } },
    { command: `npx next start -p ${V2_PORT}`, cwd: APP_DIR, url: V2_URL, reuseExistingServer: false, timeout: 120_000, env: { ...SERVER_ENV, UI_V2_ENABLED: 'true' } },
  ],
})
