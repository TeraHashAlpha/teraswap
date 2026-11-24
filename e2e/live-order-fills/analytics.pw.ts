/**
 * [A97 S-2] The Analytics tab, v1 and v2, real browser, real CSP, the REAL GET /api/analytics on the PostgREST shim
 * (postgrest-stub.ts). No wallet: the tab is public. The tables hold three confirmed swaps, a FINISHED DCA with 3 confirmed
 * fills and a LIVE (active) DCA with 2.
 *
 * Asserted always: the tab renders its feed; no transaction link of the live DCA's fills is on the page; the finished DCA's
 * fills and the swaps are. With ANALYTICS_BASELINE=<dir> (origin/main's run of this spec, ORDERS_E2E_OUT there):
 *   - every field of the /api/analytics answer except `recentTrades` equals origin/main's (the numbers the tab draws);
 *   - the transaction links on the page are origin/main's minus the live DCA's fills, in the same order (and main listed them);
 *   - no more console errors than origin/main logs.
 * The report (ORDERS_E2E_OUT) also keeps the page's whole text, so the two runs can be diffed line by line.
 */
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { Capture, settle, type ApiOverride } from '../third-party-hosts/rig'
import { answerRpc, cowFlowOverride } from '../third-party-hosts/cow-flow'
import { makeExecutionRow, makeOrderRow, makeSwapRow, prng } from '../../src/test-utils/orders-db-fixture'
import type { Row } from '../../src/test-utils/fake-postgrest'
import { startPostgrestStub, type StubDb } from './postgrest-stub'
import { DB_PORT, UPSTREAM_PORT, V1_URL, V2_URL } from './playwright.config'

const OWNER = '0x' + '7a'.repeat(20)
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

let db: StubDb
let upstream: Server
let liveFills: Row[] = []
let finishedFills: Row[] = []
let swaps: Row[] = []

test.beforeAll(async () => {
  const rand = prng(20261120)
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  const base = { wallet: OWNER, order_type: 'dca', chain_id: 1, token_in: USDC, token_out: WETH, token_in_symbol: 'USDC', token_out_symbol: 'WETH', amount_in: '500000000', dca_total: 5, router: '0x111111125421ca6dc452d289314280a0f8842a65' }
  const live = makeOrderRow(rand, { ...base, status: 'active', created_at: ago(20) })
  const finished = makeOrderRow(rand, { ...base, status: 'executed', dca_total: 3, amount_in: '300000000', created_at: ago(40) })
  liveFills = [1, 2].map((n) => ({ ...makeExecutionRow(rand, live, n), created_at: ago(20 - n * 4) }))
  finishedFills = [1, 2, 3].map((n) => ({ ...makeExecutionRow(rand, finished, n), created_at: ago(40 - n * 5) }))
  swaps = [3, 9, 30].map((h) => ({ ...makeSwapRow(rand, '0x' + '8b'.repeat(20)), token_in: USDC, token_out: WETH, created_at: ago(h) }))
  db = await startPostgrestStub(DB_PORT, { orders: [live, finished], order_executions: [...liveFills, ...finishedFills], swaps })
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

const scrubConsole = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>').replace(/0x[0-9a-fA-F]{8,}/g, '0x…').slice(0, 160)

for (const { ui, baseURL } of [{ ui: 'v1', baseURL: V1_URL }, { ui: 'v2', baseURL: V2_URL }] as const) {
  test(`${ui} · Analytics: renders as before, without the live DCA's fills in the feed`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    const capture = new Capture(new URL(baseURL).origin)
    const override: ApiOverride = (url, request) => (url.pathname === '/api/rpc' ? null : cowFlowOverride(url, request))
    capture.apiOverride = override
    await capture.install(context)
    // Registered AFTER the capture's catch-all, so it runs first: /api/analytics is the REAL route.
    await context.route(/\/api\/analytics(\?|$)/, (route) => route.continue())
    const page = await context.newPage()
    await capture.installPage(page)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(scrubConsole(m.text()))
    })
    let answer: { enabled?: boolean; dashboard?: Record<string, unknown> } | null = null
    page.on('response', async (res) => {
      if (new URL(res.url()).pathname === '/api/analytics' && res.status() === 200) answer = await res.json().catch(() => null)
    })

    const linkedHashes = () =>
      page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => (/\/tx\/(0x[0-9a-fA-F]{64})/.exec((a as HTMLAnchorElement).href) ?? [])[1]).filter(Boolean) as string[])
    const lower = (xs: Row[]) => xs.map((r) => String(r.tx_hash).toLowerCase())
    const report: Record<string, unknown> = { ui, tree: process.env.CAPTURE_APP_DIR ? 'CAPTURE_APP_DIR' : 'this tree' }
    try {
      if (ui === 'v1') {
        await page.goto(`${baseURL}/`, { waitUntil: 'load' })
        await settle(page, 2_000)
        await page.getByRole('button', { name: /launch app/i }).first().click({ timeout: 4_000 }).catch(() => {})
        await page.getByRole('button', { name: /^Analytics$/ }).first().click({ timeout: 15_000 })
      } else {
        await page.goto(`${baseURL}/analytics`, { waitUntil: 'load' })
      }
      await expect.poll(async () => (await linkedHashes()).map((h) => h.toLowerCase()).filter((h) => lower(finishedFills).includes(h)).length, { message: 'the finished DCA\'s fills are in the feed', timeout: 30_000 }).toBe(3)
      await settle(page, 1_500)
      const hashes = (await linkedHashes()).map((h) => h.toLowerCase())
      const text = await page.locator('body').innerText()
      report.linkedHashes = hashes
      report.text = text
      report.answer = answer
      report.consoleErrors = consoleErrors
      report.dbUnmapped = db.unmapped
    } finally {
      if (process.env.ORDERS_E2E_OUT) {
        mkdirSync(process.env.ORDERS_E2E_OUT, { recursive: true })
        writeFileSync(join(process.env.ORDERS_E2E_OUT, `analytics-${ui}.json`), `${JSON.stringify(report, null, 1)}\n`)
        await page.screenshot({ path: join(process.env.ORDERS_E2E_OUT, `analytics-${ui}.png`), fullPage: true }).catch(() => {})
      }
      testInfo.attach('report', { body: JSON.stringify({ ...report, text: undefined }, null, 1), contentType: 'application/json' })
      await capture.close(context)
    }

    const hashes = report.linkedHashes as string[]
    expect(db.unmapped, 'the PostgREST shim served every request the route made').toEqual([])
    expect(hashes.filter((h) => lower(liveFills).includes(h)), 'no fill of the LIVE DCA is linked on the page').toEqual([])
    expect(lower(swaps).every((h) => hashes.includes(h)), 'every swap is in the feed').toBe(true)

    const baselineFile = process.env.ANALYTICS_BASELINE ? join(process.env.ANALYTICS_BASELINE, `analytics-${ui}.json`) : ''
    if (baselineFile && existsSync(baselineFile)) {
      const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as { linkedHashes: string[]; text: string; answer: { enabled: boolean; dashboard: Record<string, unknown> } }
      const strip = (a: { enabled?: boolean; dashboard?: Record<string, unknown> } | null) => {
        const { recentTrades: _r, ...rest } = (a?.dashboard ?? {}) as Record<string, unknown>
        return JSON.stringify({ enabled: a?.enabled, rest })
      }
      expect(strip(report.answer as never), 'every number of /api/analytics equals origin/main\'s').toBe(strip(base.answer))
      expect(hashes, 'the feed is origin/main\'s minus the live DCA\'s fills, in order').toEqual(base.linkedHashes.filter((h) => !lower(liveFills).includes(h)))
      expect(base.linkedHashes.filter((h) => lower(liveFills).includes(h)).length, 'origin/main listed the live fills (the change is not vacuous)').toBe(2)
      expect(consoleErrors.length, 'console errors, against origin/main').toBeLessThanOrEqual(((base as unknown as { consoleErrors: string[] }).consoleErrors ?? []).length)
    }
  })
}
