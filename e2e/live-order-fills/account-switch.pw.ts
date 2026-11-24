/**
 * [A97 S-1] The Orders tab across an account switch, v1 and v2, real browser, real CSP, the REAL orders routes on the
 * PostgREST shim (postgrest-stub.ts). The wallet stub holds TWO keys generated per run (A owns an ACTIVE DCA with 2 fills and
 * a FINISHED one with 3; B owns nothing) and signs exactly as a wallet does: with the account `eth_signTypedData_v4` names in
 * params[0]; it can switch account (emits `accountsChanged`). The audit's path:
 *
 *   P1  connected A: open Orders, expand A's active DCA                          -> its fills show
 *   PB  switch to B: A's orders stay listed (pre-existing); A's cached read signature ages out (issuedAt past the
 *       client's 23 h 59 m window); collapse + re-expand A's active DCA            -> B is NEVER asked to sign a message naming A
 *   PA  switch back to A: re-expand A's active DCA                                -> its fills show; the cache under A recovers to A
 *       Completed: expand A's finished DCA                                       -> its fills show
 *
 * Asserted always: no prompt is ever answered by an account other than the one its message names; no prompt in PB names A;
 * A's fills are back in PA; the entry cached under A is A's own. With EXPECT_PROMPTS="p1,pb,pa" (origin/main's numbers, run
 * there with CAPTURE_APP_DIR) the per-phase prompt counts must equal them. Every signature is checked by RECOVERY in this
 * process; no signature value is printed or written.
 */
import { expect, test, type BrowserContext } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Capture, launchApp, settle, type ApiOverride } from '../third-party-hosts/rig'
import { answerRpc, cowFlowOverride } from '../third-party-hosts/cow-flow'
import { makeExecutionRow, makeOrderRow, prng } from '../../src/test-utils/orders-db-fixture'
import type { Row } from '../../src/test-utils/fake-postgrest'
import { buildOrdersReadTypedData } from '../../src/lib/order-engine/read-auth'
import { startPostgrestStub, type StubDb } from './postgrest-stub'
import { DB_PORT, UPSTREAM_PORT, V1_URL, V2_URL } from './playwright.config'

const KEYS = { A: privateKeyToAccount(generatePrivateKey()), B: privateKeyToAccount(generatePrivateKey()) }
const W = { A: KEYS.A.address.toLowerCase(), B: KEYS.B.address.toLowerCase() }
type Who = 'A' | 'B' | '?'
const who = (addr: unknown): Who => (String(addr).toLowerCase() === W.A ? 'A' : String(addr).toLowerCase() === W.B ? 'B' : '?')
const headerLabel = (a: string) => new RegExp(`0x${a.slice(2, 4)}(${a.slice(4, 6)})?(…|\\.\\.\\.)${a.slice(-4)}`, 'i')
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'
const PHASES = ['P1', 'PB', 'PA'] as const
type Phase = (typeof PHASES)[number]

let db: StubDb
let upstream: Server
let active: Row
let finished: Row
let fills: Row[] = []

function dca(rand: () => number, over: Partial<Row> & { status: string; dca_total: number; dca_executed: number; created_at: string }): Row {
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86_400
  return makeOrderRow(rand, {
    wallet: W.A, order_type: 'dca', chain_id: 1, token_in_symbol: 'USDC', token_out_symbol: 'WETH', token_in: USDC, token_out: WETH,
    token_in_decimals: 6, token_out_decimals: 18, amount_in: '100000000', min_amount_out: '0', target_price: '0', price_feed: ZERO, expiry,
    // The browser reads `order_data` as the on-chain order: bigints are stored as decimal strings.
    order_data: { owner: W.A, tokenIn: USDC, tokenOut: WETH, amountIn: '100000000', minAmountOut: '0', orderType: 2, condition: 0, targetPrice: '0',
      priceFeed: ZERO, expiry: String(expiry), nonce: '1', router: ZERO, routerDataHash: `0x${'00'.repeat(32)}`, dcaInterval: '3600', dcaTotal: String(over.dca_total) },
    ...over,
  })
}

test.beforeAll(async () => {
  const rand = prng(20261119)
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  active = dca(rand, { status: 'active', dca_total: 5, dca_executed: 2, created_at: ago(5) })
  finished = dca(rand, { status: 'executed', dca_total: 3, dca_executed: 3, created_at: ago(30), executed_at: ago(8), tx_hash: `0x${'3e'.repeat(32)}`, amount_out: '50000000000000000' })
  fills = [
    ...[1, 2].map((n) => ({ ...makeExecutionRow(rand, active, n), created_at: ago(5 - n) })),
    ...[1, 2, 3].map((n) => ({ ...makeExecutionRow(rand, finished, n), created_at: ago(30 - n * 3) })),
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

interface Prompt { phase: Phase; signer: Who; messageWallet: Who; primaryType: string }

/** Two accounts; signs with the key of params[0] (the account the page names), as a wallet does. `__e2eSwitch` = accountsChanged. */
async function installTwoAccountWallet(context: BrowserContext, prompts: Prompt[], phase: { v: Phase }) {
  await context.exposeBinding('__e2eSign', async (_src, from: string, typedJson: string) => {
    const typed = JSON.parse(typedJson) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }
    const signer = who(from)
    prompts.push({ phase: phase.v, signer, messageWallet: who(typed.message.wallet), primaryType: typed.primaryType })
    if (signer === '?') throw new Error('unknown account')
    const { EIP712Domain: _domain, ...types } = typed.types
    const message: Record<string, unknown> = { ...typed.message }
    for (const f of types[typed.primaryType] ?? []) if (/^u?int/.test(f.type)) message[f.name] = BigInt(String(message[f.name]))
    return KEYS[signer].signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message } as never)
  })
  await context.addInitScript(({ a }) => {
    let current = a
    let chain = '0x1'
    const listeners: Record<string, Array<(...x: unknown[]) => void>> = {}
    const emit = (ev: string, v: unknown) => { for (const l of listeners[ev] ?? []) l(v) }
    const provider = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        switch (method) {
          case 'eth_accounts':
          case 'eth_requestAccounts':
            return [current]
          case 'eth_chainId':
            return chain
          case 'net_version':
            return String(parseInt(chain, 16))
          case 'wallet_switchEthereumChain':
            chain = (params?.[0] as { chainId: string }).chainId
            emit('chainChanged', chain)
            return null
          case 'wallet_getPermissions':
          case 'wallet_requestPermissions':
            return [{ parentCapability: 'eth_accounts' }]
          case 'eth_signTypedData_v4':
            return (window as unknown as { __e2eSign: (f: string, j: string) => Promise<string> }).__e2eSign(String(params?.[0]), String(params?.[1]))
          default:
            return null
        }
      },
      on: (ev: string, l: (...x: unknown[]) => void) => void (listeners[ev] ??= []).push(l),
      removeListener: (ev: string, l: (...x: unknown[]) => void) => void (listeners[ev] = (listeners[ev] ?? []).filter((y) => y !== l)),
    }
    ;(window as unknown as { __e2eSwitch: (addr: string) => void }).__e2eSwitch = (addr: string) => {
      current = addr
      emit('accountsChanged', [addr])
    }
    const info = { uuid: '00000000-0000-4000-8000-0000000000ab', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
    ;(window as unknown as { ethereum: unknown }).ethereum = provider
    try {
      localStorage.setItem('wagmi.recentConnectorId', '"io.metamask"')
      localStorage.setItem('wagmi.io.metamask.connected', 'true')
    } catch {}
  }, { a: KEYS.A.address })
}

interface Call { phase: Phase; route: 'list' | 'executions'; order: 'active' | 'finished' | 'other' | '-'; urlWallet: Who; sig: 'none' | 'own' | 'OTHER' | 'bad'; status: number; cacheControl: string }

const scrubConsole = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>').replace(/0x[0-9a-fA-F]{8,}/g, '0x…').slice(0, 160)

for (const { ui, baseURL } of [{ ui: 'v1', baseURL: V1_URL }, { ui: 'v2', baseURL: V2_URL }] as const) {
  test(`${ui} · account switch: B is never asked to sign for A, and A's live fills come back when A reconnects`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
    const prompts: Prompt[] = []
    const phase = { v: 'P1' as Phase }
    const capture = new Capture(new URL(baseURL).origin)
    const override: ApiOverride = (url, request) => (url.pathname === '/api/rpc' ? null : cowFlowOverride(url, request))
    capture.apiOverride = override
    await capture.install(context)
    // Registered AFTER the capture's catch-all, so it runs first: the orders routes are the REAL ones.
    await context.route(/\/api\/orders(\/|\?|$)/, (route) => route.continue())
    await installTwoAccountWallet(context, prompts, phase)
    const page = await context.newPage()
    await capture.installPage(page)

    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`${phase.v}: ${scrubConsole(m.text())}`)
    })
    page.on('pageerror', (e) => consoleErrors.push(`${phase.v}: pageerror: ${scrubConsole(String(e))}`))
    const calls: Call[] = []
    page.on('response', async (res) => {
      const u = new URL(res.url())
      const exec = /^\/api\/orders\/([^/]+)\/executions$/.exec(u.pathname)
      const list = u.pathname === '/api/orders'
      if (!exec && !list) return
      const at = phase.v
      const h = res.request().headers()
      const urlWallet = (u.searchParams.get('wallet') ?? '').toLowerCase()
      let sig: Call['sig'] = 'none'
      if (h['x-orders-read-signature']) {
        try {
          const rec = await recoverTypedDataAddress({ ...buildOrdersReadTypedData(urlWallet, Number.parseInt(h['x-orders-read-issued'] ?? '0', 10)), signature: h['x-orders-read-signature'] as `0x${string}` })
          sig = rec.toLowerCase() === urlWallet ? 'own' : 'OTHER'
        } catch {
          sig = 'bad'
        }
      }
      calls.push({
        phase: at,
        route: exec ? 'executions' : 'list',
        order: exec ? (exec[1] === String(active.id) ? 'active' : exec[1] === String(finished.id) ? 'finished' : 'other') : '-',
        urlWallet: who(urlWallet),
        sig,
        status: res.status(),
        cacheControl: res.headers()['cache-control'] ?? '(none)',
      })
    })

    const txLinks = (hashes: string[]) =>
      page.evaluate((hs) => hs.filter((x) => [...document.querySelectorAll('a[href]')].some((a) => (a as HTMLAnchorElement).href.toLowerCase().includes(x.toLowerCase()))).length, hashes)
    const hashesOf = (o: Row) => fills.filter((f) => f.order_id === o.id).map((f) => String(f.tx_hash))
    const activeToggle = () => (ui === 'v2' ? page.locator(`[data-order-toggle="${active.id}"]`) : page.locator('button', { hasText: '2/5 fills' }).first())
    const finishedToggle = () => (ui === 'v2' ? page.locator(`[data-order-toggle="${finished.id}"]`) : page.locator('button', { hasText: '3/3 fills' }).first())
    const header = () => page.locator('header').first().innerText().catch(() => '')
    const switchTo = (addr: string) => page.evaluate((x) => (window as unknown as { __e2eSwitch: (a: string) => void }).__e2eSwitch(x), addr)
    /** Push the entry cached under `wallet` past the client's 23 h 59 m window (the 24 h TTL minus its 60 s margin). */
    const ageCache = (wallet: string) =>
      page.evaluate((w) => {
        const k = `teraswap:orders-read:${w}`
        const raw = sessionStorage.getItem(k)
        if (!raw) return 'absent'
        const v = JSON.parse(raw)
        v.issuedAt = Math.floor(Date.now() / 1000) - 86_341
        sessionStorage.setItem(k, JSON.stringify(v))
        return 'aged'
      }, wallet)
    const cacheSignerOf = async (wallet: string): Promise<Who | 'absent' | 'bad'> => {
      const raw = await page.evaluate((w) => sessionStorage.getItem(`teraswap:orders-read:${w}`), wallet)
      if (!raw) return 'absent'
      const v = JSON.parse(raw)
      try {
        return who(await recoverTypedDataAddress({ ...buildOrdersReadTypedData(wallet, v.issuedAt), signature: v.signature }))
      } catch {
        return 'bad'
      }
    }
    const activeCallsIn = (p: Phase) => calls.filter((c) => c.phase === p && c.route === 'executions' && c.order === 'active').length
    const reexpand = async () => {
      await activeToggle().click()
      await settle(page, 800)
      await activeToggle().click()
    }

    const result: Record<string, unknown> = { ui, tree: process.env.CAPTURE_APP_DIR ? 'CAPTURE_APP_DIR' : 'this tree' }
    try {
      await page.goto(`${baseURL}${ui === 'v2' ? '/orders' : '/'}`, { waitUntil: 'load' })
      await settle(page, 3_000)
      await launchApp(page)
      await expect.poll(header, { message: 'A is connected', timeout: 20_000 }).toMatch(headerLabel(W.A))
      if (ui === 'v1') await page.getByRole('button', { name: /^Orders$/ }).first().click({ timeout: 10_000 })
      await expect(activeToggle(), 'A\'s active DCA is listed').toBeVisible({ timeout: 30_000 })

      // P1: A's active DCA, expanded: its fills show.
      await activeToggle().click()
      await expect.poll(() => txLinks(hashesOf(active)), { message: 'P1: A\'s active fills on the page', timeout: 20_000 }).toBe(2)

      // PB: switch to B. A's orders stay on screen (B has none: useOrderEngine's merge-guard, pre-existing).
      phase.v = 'PB'
      await switchTo(KEYS.B.address)
      await expect.poll(header, { message: 'B is connected', timeout: 20_000 }).toMatch(headerLabel(W.B))
      await expect.poll(() => prompts.filter((p) => p.phase === 'PB' && p.signer === 'B' && p.messageWallet === 'B').length, { message: 'PB: B signs its own list read', timeout: 20_000 }).toBeGreaterThan(0)
      await expect(activeToggle(), 'PB: A\'s active DCA is still listed while B is connected').toBeVisible({ timeout: 10_000 })
      result.PB_cacheA = await ageCache(W.A)
      await reexpand()
      // Wait for the fills call of A's order made while B is connected, then for the page to act on its answer.
      await expect.poll(() => activeCallsIn('PB'), { message: 'PB: the fills of A\'s active DCA were requested', timeout: 20_000 }).toBeGreaterThan(0)
      await settle(page, 2_500)
      result.PB_cacheA_signedBy = await cacheSignerOf(W.A)

      // PA: back to A. Its fills show again; what is cached under A is A's own signature.
      phase.v = 'PA'
      await switchTo(KEYS.A.address)
      await expect.poll(header, { message: 'A is connected again', timeout: 20_000 }).toMatch(headerLabel(W.A))
      await expect(activeToggle(), 'PA: A\'s active DCA is listed').toBeVisible({ timeout: 30_000 })
      await reexpand()
      await expect.poll(() => txLinks(hashesOf(active)), { message: 'PA: A\'s active fills are back on the page', timeout: 30_000 }).toBe(2)
      await expect.poll(() => cacheSignerOf(W.A), { message: 'PA: the read signature cached under A is A\'s own', timeout: 10_000 }).toBe('A')

      await page.getByText(/Completed \(1\)/i).first().click({ timeout: 10_000 })
      await finishedToggle().click({ timeout: 15_000 })
      await expect.poll(() => txLinks(hashesOf(finished)), { message: 'PA: A\'s finished fills on the page', timeout: 20_000 }).toBe(3)
      await settle(page, 1_500)
    } finally {
      result.prompts = prompts
      result.promptsByPhase = PHASES.map((p) => prompts.filter((x) => x.phase === p).length)
      result.calls = calls
      result.consoleErrors = consoleErrors
      result.dbUnmapped = db.unmapped
      if (process.env.ORDERS_E2E_OUT) {
        mkdirSync(process.env.ORDERS_E2E_OUT, { recursive: true })
        writeFileSync(join(process.env.ORDERS_E2E_OUT, `switch-${ui}.json`), `${JSON.stringify(result, null, 1)}\n`)
        await page.screenshot({ path: join(process.env.ORDERS_E2E_OUT, `switch-${ui}-end.png`), fullPage: true }).catch(() => {})
      }
      testInfo.attach('report', { body: JSON.stringify(result, null, 1), contentType: 'application/json' })
      await capture.close(context)
    }

    expect(db.unmapped, 'the PostgREST shim served every request the routes made').toEqual([])
    expect(prompts.every((p) => p.primaryType === 'OrdersReadAccess'), 'the only thing ever signed is the read message').toBe(true)
    expect(prompts.filter((p) => p.signer !== p.messageWallet), 'no account ever signs a read message naming another wallet').toEqual([])
    expect(prompts.filter((p) => p.phase === 'PB' && p.messageWallet === 'A'), 'while B is connected, nothing naming A is signed').toEqual([])
    expect(calls.filter((c) => c.sig === 'OTHER'), 'no request ever carries another wallet\'s signature').toEqual([])
    if (process.env.EXPECT_PROMPTS !== undefined) {
      expect(result.promptsByPhase, 'wallet prompts per phase (P1, PB, PA), against origin/main').toEqual(process.env.EXPECT_PROMPTS.split(',').map(Number))
    }
  })
}
