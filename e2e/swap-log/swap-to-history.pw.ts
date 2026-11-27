/**
 * [ADR-029, details G] A swap submitted and confirmed shows in the wallet's history as today; prompts and console as on main.
 *
 * Real Chromium, production build, REAL Content-Security-Policy, v1 and v2. The page drives a whole CoW swap with an
 * extension wallet that holds no key (USDC -> USDT, quote, review, "Confirm & Sign Order", submit, poll, settled). The
 * swap is a RECORDED REAL one: the wallet is the owner of the trade in settlement 0xb4b8b53e… on Ethereum
 * (src/lib/__fixtures__/swap-receipts/1-cow-direct.json: 649.256721 USDC for 650.044918 USDT), the quote and the order
 * carry exactly those amounts, and CoW's "trades" answer names that settlement.
 *
 * What is REAL here: the Next server's POST and PATCH /api/log-swap and GET /api/history. Their database is the local
 * PostgREST shim; the server's chain reads go to a local JSON-RPC upstream that serves the recorded transaction and its
 * receipt. Everything else the page asks (/api/rpc, /api/quote, /api/swap, /api/cow/*) is answered in the page, as in
 * e2e/third-party-hosts/cow.pw.ts. Nothing leaves the machine.
 *
 * The same spec runs on a build of main (CAPTURE_APP_DIR): the swap completes there too, and its report is the
 * baseline this tree is compared with (SWAP_LOG_E2E_BASELINE): the same wallet prompts, the same console, the same
 * /api/log-swap answers and the same History row.
 *
 * [goal 133b, A103 S-4] `SWAP_LOG_E2E_LAG_RECEIPTS=n`: the server's node answers `null` to the first n receipt reads of
 * the settlement, as a provider's node that has not caught up with the browser's does. This tree answers the first
 * confirmation 202 (the hash kept as a claim), the official client asks again 2 s later, and the History row must then
 * be what main shows (main never read the chain, so the lag does not touch it).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fixture from '../../src/lib/__fixtures__/swap-receipts/1-cow-direct.json'
import { answerRpc } from '../third-party-hosts/cow-flow'
import { launchApp, settle } from '../third-party-hosts/rig'
import { DB_PORT, IS_BASELINE, UPSTREAM_PORT, V1_URL, V2_URL } from './playwright.config'
import { startSwapLogDb, type SwapLogDb } from './postgrest-stub'

/** The owner of the one Trade in the recorded settlement, and what it traded (read from the receipt's Trade event). */
const WALLET = '0x7249c6f7434dd3D884a2E1eb19b57076D5aF6F67'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const SELL_AMOUNT = '649256721'
const BUY_AMOUNT = '650044918'
const SELL_TYPED = '649.256721'
const SETTLEMENT_TX = fixture.hash
const ORDER_UID = `0x${'c0'.repeat(56)}`
const MOCK_SIGNATURE = `0x${'ab'.repeat(64)}1b`
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110'
const HEADER_LABEL = /0x72(49)?(…|\.\.\.)6f67/i

let db: SwapLogDb
let upstream: Server
const upstreamReads: Array<{ chain: number; method: string }> = []
/** How many receipt reads of the settlement the node answers `null` before it answers (the lag mode, S-4). */
const LAG_RECEIPTS = Number(process.env.SWAP_LOG_E2E_LAG_RECEIPTS ?? '0') || 0
let lagLeft = LAG_RECEIPTS

test.beforeAll(async () => {
  db = await startSwapLogDb(DB_PORT)
  // The server's chain reads: the recorded transaction and receipt on Ethereum, a healthy empty node otherwise.
  upstream = createServer((req, res) => {
    const chainId = Number(req.url?.split('/')[1]) || 1
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(200).end('swap-log upstream ok')
      let body: { id?: unknown; method?: string; params?: unknown[] }
      try {
        body = JSON.parse(raw)
      } catch {
        return void res.writeHead(400).end()
      }
      const one = (rpc: { id?: unknown; method?: string; params?: unknown[] }) => {
        upstreamReads.push({ chain: chainId, method: String(rpc.method) })
        const hash = String(rpc.params?.[0] ?? '').toLowerCase()
        const ours = chainId === 1 && hash === SETTLEMENT_TX.toLowerCase()
        if (rpc.method === 'eth_getTransactionByHash') return { jsonrpc: '2.0', id: rpc.id ?? null, result: ours ? fixture.tx : null }
        if (rpc.method === 'eth_getTransactionReceipt') {
          // The lag mode: the node has the transaction but not yet its receipt, for the first LAG_RECEIPTS asks.
          if (ours && lagLeft > 0) {
            lagLeft--
            return { jsonrpc: '2.0', id: rpc.id ?? null, result: null }
          }
          return { jsonrpc: '2.0', id: rpc.id ?? null, result: ours ? fixture.receipt : null }
        }
        return answerRpc(chainId, rpc)
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)))
    })
  })
  await new Promise<void>((done) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', done))
})

test.afterAll(async () => {
  await db?.close()
  await new Promise<void>((done) => upstream?.close(() => done()))
})

interface Report {
  ui: string
  tree: 'main' | 'branch'
  /** Wallet requests that open a prompt in a real wallet, in order. */
  walletPrompts: string[]
  /** Every /api/log-swap call the page made: method, status and answer. */
  logSwap: Array<{ method: string; status: number; body: string }>
  console: string[]
  /**
   * Console lines written by Playwright itself, not by the page: counted here, kept out of `console`. The one there is
   * ("Service Worker registration blocked by Playwright", from `serviceWorkers: 'block'`) lands at a different place
   * among the page's own warnings from run to run of the SAME build (goal 133b, browser run 1: main's build put it
   * first in one run and fifth in the next), so "console as on main" compared the harness's timing, not the tree.
   */
  harnessConsole: Record<string, number>
  pageErrors: string[]
  failedResponses: string[]
  /** Every response of status 400 or more the page received, by status and path (or host, when not ours), counted. */
  failedLoads: Record<string, number>
  historyRow: string
  swapsRows: Array<Record<string, unknown>>
  upstreamReads: Record<string, number>
}

/** A browser-extension wallet for WALLET that holds no key. It records the requests a real wallet would prompt for. */
async function installWallet(context: BrowserContext, prompts: string[]) {
  await context.exposeBinding('__walletPrompt', (_source, method: string) => void prompts.push(method))
  await context.addInitScript(
    ({ address, signature }) => {
      try {
        sessionStorage.setItem('ts_v2_intro_seen', '1')
      } catch {}
      let chain = '0x1'
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
      const prompt = (method: string) => (window as unknown as { __walletPrompt?: (m: string) => void }).__walletPrompt?.(method)
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
              prompt(method)
              chain = (params?.[0] as { chainId: string }).chainId
              for (const l of listeners.chainChanged ?? []) l(chain)
              return null
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'eth_signTypedData_v4':
              prompt(method)
              return signature
            case 'eth_sendTransaction':
            case 'personal_sign':
            case 'eth_sign':
              prompt(method)
              return null
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
    { address: WALLET, signature: MOCK_SIGNATURE },
  )
}

/** How long the stubbed CoW order stays open before it is reported fulfilled. */
const SETTLES_AFTER_MS = 8_000

/**
 * What an image the rig has no file for is answered with (token logos: the app's own logo proxy, or a list's host).
 * Not a 404: the browser writes one console error per failed image, and how many logos a token list has asked for by
 * the time it closes depends on the browser's lazy loading, not on the tree. With a 404 the console of two runs of the
 * SAME build differed by a few such lines (295 against 287), and "console as on main" compared noise.
 */
const BLANK_IMAGE = { status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }

/** The page's own /api calls: the swap log and the history go to the REAL server, the rest is answered here. */
async function routeApis(context: BrowserContext, origin: string, report: Report) {
  let submittedAt = Date.now()
  await context.route('**/*', async (route) => {
    const request = route.request()
    let url: URL
    try {
      url = new URL(request.url())
    } catch {
      return route.abort()
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()
    // Nothing leaves the machine.
    if (url.origin !== origin) return route.fulfill(request.resourceType() === 'image' ? BLANK_IMAGE : { status: 404, body: '' })
    if (!url.pathname.startsWith('/api/')) return route.continue()

    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const posted = () => {
      try {
        return request.postDataJSON() as Record<string, unknown>
      } catch {
        return {}
      }
    }

    if (url.pathname === '/api/log-swap') {
      // The REAL route handler. Its status and answer are recorded: "same responses as on main".
      try {
        const response = await route.fetch()
        report.logSwap.push({ method: request.method(), status: response.status(), body: (await response.text()).slice(0, 200) })
        return await route.fulfill({ response })
      } catch {
        return
      }
    }
    if (url.pathname === '/api/history') return route.continue()

    if (url.pathname === '/api/rpc') {
      const chainId = Number(url.searchParams.get('chainId') ?? '1')
      const body = posted() as unknown
      return json(200, Array.isArray(body) ? body.map((b) => answerRpc(chainId, b)) : answerRpc(chainId, body as never))
    }
    if (url.pathname === '/api/quote') {
      const q = url.searchParams
      const best = { source: 'cowswap', toAmount: BUY_AMOUNT, estimatedGas: 0, gasUsd: 0, routes: ['CoW Protocol'] }
      return json(200, {
        best, all: [best], fetchedAt: Date.now(), tokenIn: q.get('src'), tokenOut: q.get('dst'), chainId: Number(q.get('chainId') ?? '1'),
        decimalsIn: Number(q.get('srcDecimals') ?? '6'), decimalsOut: Number(q.get('dstDecimals') ?? '6'), amountIn: q.get('amount'),
      })
    }
    if (url.pathname === '/api/swap') {
      const b = posted() as { src?: string; dst?: string; amount?: string; from?: string }
      return json(200, {
        source: 'cowswap', toAmount: BUY_AMOUNT, estimatedGas: 0, gasUsd: 0, routes: ['CoW Protocol'],
        cowOrderParams: {
          sellToken: b.src, buyToken: b.dst, sellAmount: b.amount, buyAmount: BUY_AMOUNT, validTo: Math.floor(Date.now() / 1000) + 600,
          appData: JSON.stringify({ version: '1.1.0', appCode: 'TeraSwap', metadata: {} }), appDataHash: `0x${'a'.repeat(64)}`, feeAmount: '0', kind: 'sell',
          partiallyFillable: false, receiver: b.from, sellTokenBalance: 'erc20', buyTokenBalance: 'erc20', from: b.from, quoteId: 1, signingScheme: 'eip712',
        },
      })
    }
    if (url.pathname === '/api/spender') return json(200, { spender: COW_VAULT_RELAYER })
    if (url.pathname === '/api/cow/orders') {
      submittedAt = Date.now()
      return json(201, ORDER_UID)
    }
    // A CoW order is settled by a solver some seconds after it is submitted, never at once: the order stays open for
    // SETTLES_AFTER_MS, as it does on the real orderbook, so the page's "submitted" log call is answered before its
    // "confirmed" one is sent (on main that first call also prices the declared amounts, which takes a moment).
    if (url.pathname === '/api/cow/order-status') return json(200, { uid: ORDER_UID, status: Date.now() - submittedAt >= SETTLES_AFTER_MS ? 'fulfilled' : 'open' })
    if (url.pathname === '/api/cow/trades') return json(200, [{ orderUid: ORDER_UID, txHash: SETTLEMENT_TX, executedBuyAmount: BUY_AMOUNT }])
    if (url.pathname === '/api/token-logo' || url.pathname === '/api/proxy/logo') return route.fulfill(BLANK_IMAGE)
    return json(200, {})
  })
}

const UIS = [
  {
    ui: 'v1',
    baseURL: V1_URL,
    flip: (page: Page) => page.locator('button', { hasText: '⇅' }).first(),
    amount: (page: Page) => page.getByPlaceholder('0.0').first(),
    receiveToken: (page: Page) => page.getByRole('button', { name: /ETH/ }).last(),
    search: (page: Page) => page.getByPlaceholder(/search name, symbol/i),
    // v1's token list is a panel of buttons: "USDT USDT Tether USD 0xdAC1…1ec7 …".
    pickUsdt: (page: Page) => page.getByRole('button', { name: /^USDT\b.*Tether USD/ }).first(),
    ctaReady: async (page: Page) => expect(page.getByRole('button', { name: /^Swap$/ })).toHaveCount(2, { timeout: 30_000 }),
    cta: (page: Page) => page.getByRole('button', { name: /^Swap$/ }).last(),
    openHistory: (page: Page) => page.getByRole('button', { name: /^History$/ }).first(),
    // A row of v1's WalletHistory: the bordered line that says "via <source>".
    historyRow: (page: Page) => page.locator('div.rounded-xl.border', { hasText: /via / }).filter({ hasText: '→' }).first(),
  },
  {
    ui: 'v2',
    baseURL: V2_URL,
    flip: (page: Page) => page.getByRole('button', { name: 'Swap sell and receive tokens' }).first(),
    amount: (page: Page) => page.getByRole('textbox', { name: 'Sell amount' }).first(),
    receiveToken: (page: Page) => page.getByRole('button', { name: /^Receive token:/ }).first(),
    search: (page: Page) => page.getByPlaceholder(/search/i).first(),
    pickUsdt: (page: Page) => page.getByRole('dialog').getByText('USDT', { exact: true }).first(),
    ctaReady: async () => {},
    cta: (page: Page) => page.getByRole('button', { name: /^Review swap$/ }).first(),
    openHistory: (page: Page) => page.getByRole('tab', { name: 'History' }).first(),
    historyRow: (page: Page) => page.getByTestId('history-row').first(),
  },
] as const

/** Console lines Playwright itself writes into the page (see Report.harnessConsole): exact texts, nothing else. */
const HARNESS_LINES = new Set(['Service Worker registration blocked by Playwright'])

/** Lines that differ from run to run for reasons that have nothing to do with the swap (timings, generated ids). */
const normalize = (line: string) => line.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<origin>').replace(/\b\d+(\.\d+)?\s?ms\b/g, '<n> ms').replace(/_next\/static\/[^\s"')]+/g, '<asset>').slice(0, 300)

for (const { ui, baseURL, flip, amount, receiveToken, search, pickUsdt, ctaReady, cta, openHistory, historyRow } of UIS) {
  test(`${ui} · a CoW swap of a recorded real trade: logged, confirmed, and shown in the wallet's history`, async ({ browser }) => {
    const report: Report = { ui, tree: IS_BASELINE ? 'main' : 'branch', walletPrompts: [], logSwap: [], console: [], harnessConsole: {}, pageErrors: [], failedResponses: [], failedLoads: {}, historyRow: '', swapsRows: [], upstreamReads: {} }
    const failedLoads = new Map<string, number>()
    db.db.rows().length = 0
    upstreamReads.length = 0
    lagLeft = LAG_RECEIPTS

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    await routeApis(context, new URL(baseURL).origin, report)
    await installWallet(context, report.walletPrompts)
    const page = await context.newPage()
    await page.routeWebSocket(/.*/, (ws) => (new URL(ws.url()).host === new URL(baseURL).host ? void ws.connectToServer() : void ws.close()))
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return
      const line = `${message.type()}: ${normalize(message.text())}`
      if (HARNESS_LINES.has(message.text())) report.harnessConsole[line] = (report.harnessConsole[line] ?? 0) + 1
      else report.console.push(line)
    })
    page.on('pageerror', (error) => void report.pageErrors.push(normalize(String(error))))
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (response.status() >= 400) {
        const ours = url.pathname.startsWith('/_next/static/') ? '/_next/static/<asset>' : url.pathname
        const what = `${response.status()} ${url.origin === new URL(baseURL).origin ? ours : url.host}`
        failedLoads.set(what, (failedLoads.get(what) ?? 0) + 1)
      }
      if (response.status() >= 400 && url.origin === new URL(baseURL).origin && url.pathname.startsWith('/api/') && !/token-logo|proxy\/logo/.test(url.pathname)) {
        report.failedResponses.push(`${response.request().method()} ${url.pathname} ${response.status()}`)
      }
    })

    await page.goto(`${baseURL}/`, { waitUntil: 'load' })
    await settle(page, 3_000)
    await launchApp(page)
    await expect.poll(() => page.locator('header').first().innerText(), { message: 'the wallet reconnected', timeout: 20_000 }).toMatch(HEADER_LABEL)

    // USDC -> USDT: flip the default pair (ETH -> USDC becomes USDC -> ETH), then choose USDT as the token to receive.
    await flip(page).click({ timeout: 8_000 })
    await settle(page, 800)
    await receiveToken(page).click({ timeout: 8_000 })
    await search(page).fill('USDT')
    await settle(page, 800)
    await pickUsdt(page).click({ timeout: 8_000 })
    await settle(page, 800)
    await amount(page).fill(SELL_TYPED)
    await ctaReady(page)
    const button = cta(page)
    await expect(button, 'the swap button is ready').toBeEnabled({ timeout: 30_000 })
    await button.click()

    const until = async (done: () => Promise<boolean> | boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await settle(page, 500)) if (await done()) return true
      return false
    }
    // Review, then "Confirm & Sign Order" (v1), or the review sheet's confirm (v2), until a PATCH has been answered 200
    // (in the lag mode, this tree's first PATCH is answered 202 and the client's second asking, 2 s later, is the one).
    const patched = () => report.logSwap.some((c) => c.method === 'PATCH' && c.status === 200)
    await until(async () => {
      if (patched()) return true
      for (const confirm of [page.getByRole('button', { name: /confirm & sign order/i }), page.getByTestId('review-confirm')]) {
        if (await confirm.first().isVisible().catch(() => false)) await confirm.first().click().catch(() => {})
      }
      return false
    }, 60_000)
    expect(patched(), 'the swap was submitted, settled and its confirmation sent').toBe(true)
    await settle(page, 2_500)

    // The wallet's own history.
    await page.keyboard.press('Escape').catch(() => {})
    await settle(page, 500)
    for (const close of [page.getByRole('button', { name: /^(close|done|dismiss)$/i }), page.getByRole('button', { name: /new swap/i })]) {
      if (await close.first().isVisible().catch(() => false)) await close.first().click().catch(() => {})
    }
    await openHistory(page).click({ timeout: 10_000 })
    const row = historyRow(page)
    await expect(row, 'the swap is a row of the History tab').toBeVisible({ timeout: 20_000 })
    // The row as the user reads it: amounts, symbols, status, source, USD, the transaction link. "How long ago" is
    // left out, as the one part that depends on when the run happened.
    report.historyRow = (await row.innerText())
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !/^(just now|\d+\s?[smhd]( ago)?|\d+ (sec|min|hour|day)s? ago)$/i.test(l))
      .join(' | ')
    expect(await page.getByTestId('history-row').count() + await page.locator('div.rounded-xl.border', { hasText: /via / }).filter({ hasText: '→' }).count(), 'exactly one row').toBe(1)

    report.swapsRows = db.db.rows().map((r) => ({ ...r }))
    const reads = new Map<string, number>()
    for (const read of upstreamReads) reads.set(`${read.chain}:${read.method}`, (reads.get(`${read.chain}:${read.method}`) ?? 0) + 1)
    report.upstreamReads = Object.fromEntries(reads)
    report.failedLoads = Object.fromEntries([...failedLoads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

    if (process.env.SWAP_LOG_E2E_OUT) {
      mkdirSync(process.env.SWAP_LOG_E2E_OUT, { recursive: true })
      writeFileSync(join(process.env.SWAP_LOG_E2E_OUT, `swap-to-history-${ui}.json`), `${JSON.stringify(report, null, 1)}\n`)
    }
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()

    // ── On every tree: the official client's flow is whole ──
    expect(db.unmapped, 'requests the database shim could not map').toEqual([])
    expect(report.pageErrors, 'uncaught page errors').toEqual([])
    expect(report.walletPrompts, 'one signature prompt (the CoW order), nothing else').toEqual(['eth_signTypedData_v4'])
    // The lag mode on this tree: the first confirmation is answered 202 (the claim kept), the client's second asking 200.
    const lagged = LAG_RECEIPTS > 0 && !IS_BASELINE
    expect(report.logSwap.map((c) => `${c.method} ${c.status} ${c.body}`), 'the swap log calls and their answers').toEqual(
      lagged ? ['POST 200 {"ok":true}', 'PATCH 202 {"ok":false,"outcome":"not_found"}', 'PATCH 200 {"ok":true}'] : ['POST 200 {"ok":true}', 'PATCH 200 {"ok":true}'],
    )
    expect(report.failedResponses, 'no /api call of the page failed').toEqual([])
    expect(report.historyRow).toMatch(/649\.25\d* USDC/)
    expect(report.historyRow).toMatch(/650\.04\d* USDT/)
    expect(report.historyRow).toMatch(/confirmed/i)
    expect(report.swapsRows).toHaveLength(1)
    expect(report.swapsRows[0]).toMatchObject({ wallet: WALLET.toLowerCase(), status: 'confirmed', source: 'cowswap', token_in: USDC.toLowerCase(), token_out: USDT.toLowerCase(), amount_in: SELL_AMOUNT, amount_out: BUY_AMOUNT })
    expect(String(report.swapsRows[0].tx_hash).toLowerCase()).toBe(SETTLEMENT_TX.toLowerCase())

    if (!IS_BASELINE) {
      // ── This tree: the row is what the SERVER read on-chain ──
      expect(report.swapsRows[0]).toMatchObject({ verified_kind: 'cow', token_in_symbol: 'USDC', token_out_symbol: 'USDT', is_gasless: true, mev_protected: true, fee_collected: false, gas_savings_usd: 0 })
      expect(typeof report.swapsRows[0].verified_at).toBe('string')
      expect(report.swapsRows[0].gas_used).toBe(BigInt(fixture.receipt.gasUsed).toString())
      // One confirmation: the transaction and its receipt, read on Ethereum (plus the chain-id proof, once per server).
      // Lag mode: two confirmations; the receipt is asked twice (null, null: 202) and then once more (there).
      expect(report.upstreamReads['1:eth_getTransactionByHash']).toBe(lagged ? 2 : 1)
      expect(report.upstreamReads['1:eth_getTransactionReceipt']).toBe(lagged ? 1 + LAG_RECEIPTS : 1)
      // The claim of the first confirmation was decided by the second: none is left.
      expect(report.swapsRows[0].claimed_tx_hash ?? null).toBeNull()

      const baselineFile = process.env.SWAP_LOG_E2E_BASELINE ? join(process.env.SWAP_LOG_E2E_BASELINE, `swap-to-history-${ui}.json`) : null
      if (baselineFile && existsSync(baselineFile)) {
        const main = JSON.parse(readFileSync(baselineFile, 'utf8')) as Report
        expect(main.tree).toBe('main')
        expect(report.walletPrompts, 'wallet prompts as on main').toEqual(main.walletPrompts)
        expect(report.console, 'console warnings and errors as on main').toEqual(main.console)
        expect(report.harnessConsole, 'the harness\'s own console lines, counted, as on main').toEqual(main.harnessConsole)
        // Lag mode: the answers main gave are the first and the last of this tree's (the 202 between them is not seen).
        expect(lagged ? [report.logSwap[0], report.logSwap[report.logSwap.length - 1]] : report.logSwap, '/api/log-swap answers as on main').toEqual(main.logSwap)
        expect(report.failedResponses).toEqual(main.failedResponses)
        expect(report.historyRow, 'the History row as on main').toBe(main.historyRow)
      }
    }
  })
}
