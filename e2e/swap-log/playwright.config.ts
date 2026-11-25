import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * [ADR-029, details G] A swap in a real browser, v1 and v2, against a PRODUCTION build whose /api/log-swap and
 * /api/history are the REAL handlers: the swap log is written to a local PostgREST shim (postgrest-stub.ts, the same
 * fake database the vitest route tests use) and the confirmation is verified against a local JSON-RPC upstream that
 * serves a recorded REAL transaction. Nothing leaves the machine. LOCAL ONLY: no CI workflow runs this config.
 *
 *   # once per tree under test: a production build (the public env of .github/workflows/e2e.yml)
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=00000000000000000000000000000000 NEXT_PUBLIC_DCA_ENABLED=true npm run build
 *   npx playwright test --config e2e/swap-log/playwright.config.ts                 # this tree
 *   CAPTURE_APP_DIR=/path/to/origin-main-tree npx playwright test --config ...     # the baseline: same spec, main's build
 *
 * `SWAP_LOG_E2E_OUT` is a directory that receives one JSON report per UI (wallet prompts, the /api/log-swap answers, the
 * console, the History row). `SWAP_LOG_E2E_BASELINE` is such a directory written by a run on main: the spec then asserts
 * that prompts, console and the History row are the same as on main.
 */
const REPO_ROOT = resolve(__dirname, '../..')
const APP_DIR = process.env.CAPTURE_APP_DIR ? resolve(process.env.CAPTURE_APP_DIR) : REPO_ROOT
export const IS_BASELINE = Boolean(process.env.CAPTURE_APP_DIR)
export const V1_PORT = 3961
export const V2_PORT = 3962
export const UPSTREAM_PORT = 3963
export const DB_PORT = 3964
export const V1_URL = `http://127.0.0.1:${V1_PORT}`
export const V2_URL = `http://127.0.0.1:${V2_PORT}`

/** Server-only names: the chain is read from the local upstream, the swap log is written to the local shim. */
const SERVER_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  RPC_URL_1: `http://127.0.0.1:${UPSTREAM_PORT}/1`,
  RPC_URL_8453: `http://127.0.0.1:${UPSTREAM_PORT}/8453`,
  RPC_URL_42161: `http://127.0.0.1:${UPSTREAM_PORT}/42161`,
  SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: 'e2e-service-role-dummy',
  SUPABASE_LOGGER_KEY: '',
  SWAPS_PUBLIC_VERIFIED_ONLY: '',
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
