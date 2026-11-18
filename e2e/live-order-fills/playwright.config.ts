import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * [fix/live-order-fills-need-signature, A87b R2-1] The Orders tab in a real browser, v1 and v2, wallet connected, against a
 * PRODUCTION build whose server routes are the REAL ones: GET /api/orders and GET /api/orders/:id/executions run their
 * real handlers (the read-signature gate included) on a local PostgREST shim (postgrest-stub.ts) over the same fake
 * database the vitest route tests use. LOCAL ONLY: no CI workflow runs this config.
 *
 *   # once per tree under test: a production build (the same public env as .github/workflows/e2e.yml)
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=00000000000000000000000000000000 NEXT_PUBLIC_DCA_ENABLED=true npm run build
 *   npx playwright test --config e2e/live-order-fills/playwright.config.ts            # this tree (starts `next start` x2 itself)
 *   CAPTURE_APP_DIR=/path/to/origin-main-tree npx playwright test --config ...        # the baseline: same spec, other tree
 *
 * `ORDERS_E2E_OUT` is a directory that receives one JSON report per UI (the prompt counts, the executions calls, the console).
 * Same CSP, service-worker and capture discipline as e2e/third-party-hosts. Ports differ from every other rig so they can coexist.
 */
const REPO_ROOT = resolve(__dirname, '../..')
const APP_DIR = process.env.CAPTURE_APP_DIR ? resolve(process.env.CAPTURE_APP_DIR) : REPO_ROOT
export const UPSTREAM_PORT = 3953
export const DB_PORT = 3954
export const V1_PORT = 3951
export const V2_PORT = 3952
export const V1_URL = `http://127.0.0.1:${V1_PORT}`
export const V2_URL = `http://127.0.0.1:${V2_PORT}`

/**
 * Server-only names. `/api/rpc` reads from the local JSON-RPC stub; the orders routes read the local PostgREST shim
 * (SUPABASE_URL is the server-side name, src/app/api/orders/route.ts getSupabase). The key is a dummy: the shim ignores it.
 */
const SERVER_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  RPC_URL_1: `http://127.0.0.1:${UPSTREAM_PORT}/1`,
  RPC_URL_8453: `http://127.0.0.1:${UPSTREAM_PORT}/8453`,
  RPC_URL_42161: `http://127.0.0.1:${UPSTREAM_PORT}/42161`,
  SUPABASE_URL: `http://127.0.0.1:${DB_PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: 'e2e-service-role-dummy',
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
