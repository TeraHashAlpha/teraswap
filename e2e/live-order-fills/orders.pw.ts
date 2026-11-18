/**
 * [fix/live-order-fills-need-signature, A87b R2-1] The Orders tab, v1 and v2, real browser, wallet connected, real CSP, the REAL
 * route handlers behind it (GET /api/orders and GET /api/orders/:id/executions, read-signature gate included) on a local
 * PostgREST shim over the vitest fake database (postgrest-stub.ts).
 *
 * Per UI it opens the Orders tab for a wallet that holds an ACTIVE DCA (2 of 5 fills) and a FINISHED one (3 of 3), expands each,
 * and checks:
 *   - the fills of the active DCA show (their transaction links are on the page);
 *   - the fills of the finished DCA show;
 *   - the wallet is asked exactly as often as `origin/main` asks it: every `eth_signTypedData_v4` is counted (EXPECT_PROMPTS
 *     pins the baseline's number; the report always records it);
 *   - the executions call of the ACTIVE order carries the read-signature headers, the one of the FINISHED order is answered 200
 *     whatever it carries;
 *   - no console error beyond the ones the baseline logs (the list's first unsigned fetch is a logged 401 there too, A87 S-6).
 *
 * The wallet is a stub that holds a real (published Anvil) key in THIS process: the page asks it to sign, a binding signs with
 * viem, so the server's gate verifies a genuine EIP-712 signature. Nothing leaves the machine. No signature is ever printed:
 * the report records header NAMES and statuses only.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { createServer, type Server } from 'node:http'
import { Capture, launchApp, settle, type ApiOverride } from '../third-party-hosts/rig'
import { answerRpc, cowFlowOverride } from '../third-party-hosts/cow-flow'
import { makeExecutionRow, makeOrderRow, prng } from '../../src/test-utils/orders-db-fixture'
import type { Row } from '../../src/test-utils/fake-postgrest'
import { startPostgrestStub, type StubDb } from './postgrest-stub'
import { DB_PORT, UPSTREAM_PORT, V1_URL, V2_URL } from './playwright.config'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml): NOT a secret.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const WALLET = account.address.toLowerCase()
const CONNECTED = /0xf3(9f)?(…|\.\.\.)2266/i

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'

let db: StubDb
let upstream: Server
let active: Row
let finished: Row
let fills: Row[] = []

function dcaRow(rand: () => number, over: Partial<Row> & { status: string; dca_total: number; dca_executed: number; created_at: string }): Row {
  return makeOrderRow(rand, {
    wallet: WALLET,
    order_type: 'dca',
    chain_id: 1,
    token_in_symbol: 'USDC',
    token_out_symbol: 'WETH',
    token_in: USDC,
    token_out: WETH,
    token_in_decimals: 6,
    token_out_decimals: 18,
    amount_in: '100000000',
    min_amount_out: '0',
    target_price: '0',
    price_feed: ZERO,
    expiry: Math.floor(Date.now() / 1000) + 30 * 86_400,
    // The browser reads `order_data` as the on-chain order: bigints are stored as decimal strings.
    order_data: {
      owner: WALLET,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: '100000000',
      minAmountOut: '0',
      orderType: 2,
      condition: 0,
      targetPrice: '0',
      priceFeed: ZERO,
      expiry: String(Math.floor(Date.now() / 1000) + 30 * 86_400),
      nonce: '1',
      router: ZERO,
      routerDataHash: `0x${'00'.repeat(32)}`,
      dcaInterval: '3600',
      dcaTotal: String(over.dca_total),
    },
    ...over,
  })
}

test.beforeAll(async () => {
  const rand = prng(20261118)
  const hourAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  active = dcaRow(rand, { status: 'active', dca_total: 5, dca_executed: 2, created_at: hourAgo(5) })
  finished = dcaRow(rand, { status: 'executed', dca_total: 3, dca_executed: 3, created_at: hourAgo(30), executed_at: hourAgo(8), tx_hash: `0x${'3c'.repeat(32)}`, amount_out: '50000000000000000' })
  fills = [
    ...[1, 2].map((n) => ({ ...makeExecutionRow(rand, active, n), created_at: hourAgo(5 - n) })),
    ...[1, 2, 3].map((n) => ({ ...makeExecutionRow(rand, finished, n), created_at: hourAgo(30 - n * 3) })),
  ]
  db = await startPostgrestStub(DB_PORT, { orders: [active, finished], order_executions: fills })
  upstream = createServer((req, res) => {
    const chainId = Number(req.url?.split('/')[1]) || 1
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(200).end('upstream stub ok')
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return void res.writeHead(400).end()
      }
      const answer = Array.isArray(body) ? body.map((b) => answerRpc(chainId, b)) : answerRpc(chainId, body as never)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((done) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', done))
})

test.afterAll(async () => {
  await db.close()
  await new Promise<void>((done) => upstream.close(() => done()))
})

interface Prompt { method: string; primaryType: string }

/** A wallet stub that SIGNS (viem, in this process): the page's `eth_signTypedData_v4` goes through `__e2eSign`. */
async function installSigningWallet(context: BrowserContext, prompts: Prompt[]) {
  await context.exposeBinding('__e2eSign', async (_src, typedJson: string) => {
    const typed = JSON.parse(typedJson) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }
    prompts.push({ method: 'eth_signTypedData_v4', primaryType: typed.primaryType })
    const { EIP712Domain: _domain, ...types } = typed.types
    const message: Record<string, unknown> = { ...typed.message }
    for (const f of types[typed.primaryType] ?? []) if (/^u?int/.test(f.type)) message[f.name] = BigInt(String(message[f.name]))
    return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message } as never)
  })
  await context.addInitScript(
    ({ address }) => {
      let chain = '0x1'
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
      const provider = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [address]
            case 'eth_chainId':
              return chain
            case 'net_version':
              return String(parseInt(chain, 16))
            case 'wallet_switchEthereumChain':
              chain = (params?.[0] as { chainId: string }).chainId
              for (const l of listeners.chainChanged ?? []) l(chain)
              return null
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'eth_signTypedData_v4':
              return (window as unknown as { __e2eSign: (j: string) => Promise<string> }).__e2eSign(String(params?.[1]))
            default:
              return null
          }
        },
        on: (event: string, l: (...a: unknown[]) => void) => void (listeners[event] ??= []).push(l),
        removeListener: (event: string, l: (...a: unknown[]) => void) => void (listeners[event] = (listeners[event] ?? []).filter((x) => x !== l)),
      }
      const info = { uuid: '00000000-0000-4000-8000-0000000000aa', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
      ;(window as unknown as { ethereum: unknown }).ethereum = provider
      try {
        localStorage.setItem('wagmi.recentConnectorId', '"io.metamask"')
        localStorage.setItem('wagmi.io.metamask.connected', 'true')
      } catch {}
    },
    { address: account.address },
  )
}

interface ExecCall { order: 'active' | 'finished' | 'other'; sentReadHeaders: boolean; status: number }

/** The page's own `Failed to load resource` lines carry a URL; keep the status, drop everything that could hold a value. */
const scrubConsole = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>').replace(/0x[0-9a-fA-F]{8,}/g, '0x…').slice(0, 160)

const UIS = [{ ui: 'v1', baseURL: V1_URL }, { ui: 'v2', baseURL: V2_URL }] as const

for (const { ui, baseURL } of UIS) {
  test(`${ui} · Orders tab: the active DCA's fills and the finished DCA's fills show; the wallet is asked as often as origin/main asks`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    const prompts: Prompt[] = []
    const capture = new Capture(new URL(baseURL).origin)
    const override: ApiOverride = (url, request) => (url.pathname === '/api/rpc' ? null : cowFlowOverride(url, request))
    capture.apiOverride = override
    await capture.install(context)
    // Registered AFTER the capture's catch-all, so it runs first: the orders routes are the REAL ones (everything else stays the rig's).
    await context.route(/\/api\/orders(\/|\?|$)/, (route) => route.continue())
    await installSigningWallet(context, prompts)

    const page = await context.newPage()
    await capture.installPage(page)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(scrubConsole(m.text()))
    })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${scrubConsole(String(e))}`))
    const execCalls: ExecCall[] = []
    page.on('response', (res) => {
      const m = /\/api\/orders\/([^/]+)\/executions/.exec(new URL(res.url()).pathname)
      if (!m) return
      const headers = res.request().headers()
      execCalls.push({
        order: m[1] === String(active.id) ? 'active' : m[1] === String(finished.id) ? 'finished' : 'other',
        sentReadHeaders: 'x-orders-read-signature' in headers && 'x-orders-read-issued' in headers,
        status: res.status(),
      })
    })

    const dump = async (label: string) => {
      if (!process.env.ORDERS_E2E_OUT) return
      mkdirSync(process.env.ORDERS_E2E_OUT, { recursive: true })
      await page.screenshot({ path: join(process.env.ORDERS_E2E_OUT, `${ui}-${label}.png`), fullPage: true }).catch(() => {})
    }
    const txLinkCount = (hashes: string[]) =>
      page.evaluate((hs) => hs.filter((h) => [...document.querySelectorAll('a[href]')].some((a) => (a as HTMLAnchorElement).href.toLowerCase().includes(h.toLowerCase()))).length, hashes)
    const hashesOf = (order: Row) => fills.filter((f) => f.order_id === order.id).map((f) => String(f.tx_hash))

    try {
      await page.goto(`${baseURL}${ui === 'v2' ? '/orders' : '/'}`, { waitUntil: 'load' })
      await settle(page, 3_000)
      await launchApp(page)
      await expect.poll(() => page.locator('header').first().innerText(), { message: 'the wallet is connected', timeout: 20_000 }).toMatch(CONNECTED)
      if (ui === 'v1') await page.getByRole('button', { name: /^Orders$/ }).first().click({ timeout: 10_000 })

      // The list: its first fetch is unsigned (a logged 401 on origin/main too), the page signs once and retries.
      const activeToggle = ui === 'v2' ? page.locator(`[data-order-toggle="${active.id}"]`) : page.locator('button', { hasText: '2/5 fills' }).first()
      const finishedToggle = ui === 'v2' ? page.locator(`[data-order-toggle="${finished.id}"]`) : page.locator('button', { hasText: '3/3 fills' }).first()
      await expect(activeToggle, 'the active DCA is listed').toBeVisible({ timeout: 30_000 })
      await dump('1-list')

      // 1. Expand the ACTIVE DCA: its fills show.
      await activeToggle.click()
      await expect.poll(() => txLinkCount(hashesOf(active)), { message: 'the active DCA\'s fills are on the page', timeout: 20_000 }).toBe(2)
      await dump('2-active-expanded')

      // 2. Open the Completed list (both UIs keep finished orders there), expand the FINISHED DCA: its fills show.
      await page.getByText(/Completed \(1\)/i).first().click({ timeout: 10_000 })
      await expect(finishedToggle, 'the finished DCA is listed under Completed').toBeVisible({ timeout: 15_000 })
      await finishedToggle.click()
      await expect.poll(() => txLinkCount(hashesOf(finished)), { message: 'the finished DCA\'s fills are on the page', timeout: 20_000 }).toBe(3)
      await dump('3-finished-expanded')
      await settle(page, 1_500)

      const reads = execCalls.filter((c) => c.order !== 'other')
      const report = {
        ui,
        tree: process.env.CAPTURE_APP_DIR ? 'CAPTURE_APP_DIR' : 'this tree',
        prompts: prompts.map((p) => p.primaryType),
        promptCount: prompts.length,
        executionsCalls: reads,
        consoleErrors,
        dbUnmapped: db.unmapped,
      }
      if (process.env.ORDERS_E2E_OUT) {
        mkdirSync(process.env.ORDERS_E2E_OUT, { recursive: true })
        writeFileSync(join(process.env.ORDERS_E2E_OUT, `report-${ui}.json`), `${JSON.stringify(report, null, 1)}\n`)
      }
      testInfo.attach('report', { body: JSON.stringify(report, null, 1), contentType: 'application/json' })

      expect(db.unmapped, 'the PostgREST shim served every request the routes made').toEqual([])
      expect(prompts.every((p) => p.primaryType === 'OrdersReadAccess'), 'the only thing the wallet is ever asked to sign is the read message').toBe(true)
      if (process.env.EXPECT_PROMPTS !== undefined) expect(prompts.length, 'wallet prompts, against origin/main').toBe(Number(process.env.EXPECT_PROMPTS))
      // The ACTIVE order's fills were answered 200 (a 401 here would have hidden them, and the test above would have failed).
      expect(reads.filter((c) => c.order === 'active').length, 'the active order\'s fills were requested').toBeGreaterThan(0)
      expect(reads.filter((c) => c.order === 'active').every((c) => c.status === 200), 'every executions call of the active order was answered 200').toBe(true)
      expect(reads.filter((c) => c.order === 'finished').every((c) => c.status === 200), 'every executions call of the finished order was answered 200').toBe(true)
      // On the fix, each of them carried the read signature the Orders tab already holds.
      if (process.env.EXPECT_ACTIVE_HEADERS === 'yes') expect(reads.filter((c) => c.order === 'active').every((c) => c.sentReadHeaders), 'the active order\'s executions calls carry the read-signature headers').toBe(true)
      if (process.env.EXPECT_CONSOLE_ERRORS !== undefined) expect(consoleErrors.length, 'console errors, against origin/main').toBeLessThanOrEqual(Number(process.env.EXPECT_CONSOLE_ERRORS))
    } finally {
      await capture.close(context)
    }
  })
}

export type { Page }
