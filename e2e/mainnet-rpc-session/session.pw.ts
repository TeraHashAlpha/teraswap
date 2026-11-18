/**
 * [fix/mainnet-rpc-out-of-client, SEC-5] Mainnet, wallet stub connected, v1 and v2, real browser, real CSP, every read
 * through the REAL /api/rpc route handler (its allow-list and its rate limit run on every call).
 *
 * Per UI it proves: balances load, a quote returns, the allowance read works, zero console errors; it lists every host
 * the browser contacted (our own origin only, never the retired NEXT_PUBLIC_RPC_URL marker host); it counts the JSON-RPC
 * calls (= rate-limit units, rpc-cost-policy.ts) of loading the swap screen and of one quote, and the busiest 60 s of
 * the session, against RPC_RATE_LIMIT (300 per minute per client); and it checks that every method the mainnet client
 * sent is on the chain-1 allow-list (rpc-method-policy.ts) and that /api/rpc refused nothing.
 *
 * What answers what: /api/rpc → the real route → RPC_URL_1 = the ABI-aware stub below (cow-flow.ts answers: ERC-20
 * balances / allowances through Multicall3, Chainlink feeds that self-identify, ETH = $3 000). /api/quote → a fixture
 * (cow-flow.ts). Every other /api/* → `{}` (rig.ts). Nothing leaves the machine. Run: see playwright.config.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodeFunctionData, parseAbi, type Hex } from 'viem'
import { allowedReadMethods } from '../../src/lib/rpc-method-policy'
import { Capture, CONNECTED_LABEL, installMockWallet, launchApp, settle, type ApiOverride } from '../third-party-hosts/rig'
import { answerRpc, cowFlowOverride } from '../third-party-hosts/cow-flow'
import { UPSTREAM_PORT, V1_URL, V2_URL } from './playwright.config'

/**
 * /api/rpc's per-client budget, read from the source (kv-rate-limiter.ts builds an Upstash client at import, which this
 * runner has no use for). A parse failure throws: the comparison below is never made against a guessed number.
 */
const RPC_RATE_LIMIT = (() => {
  const src = readFileSync(resolve(__dirname, '../../src/lib/kv-rate-limiter.ts'), 'utf8')
  const m = /export const RPC_RATE_LIMIT = \{ limit: (\d+), windowMs: ([\d_]+) \}/.exec(src)
  if (!m) throw new Error('RPC_RATE_LIMIT not found in src/lib/kv-rate-limiter.ts')
  return { limit: Number(m[1]), windowMs: Number(m[2].replace(/_/g, '')) }
})()

/** The retired names' marker hosts (playwright.config.ts build line; e2e.yml uses the same values). */
const MARKER_HOSTS = ['mainnet-provider.invalid', 'fallback1-provider.invalid', 'fallback2-provider.invalid']

/** Selectors worth naming in the report: the reads the swap gates depend on. */
const SELECTORS: Record<string, string> = {
  '0x70a08231': 'balanceOf',
  '0x4d2301cc': 'getEthBalance',
  '0xdd62ed3e': 'allowance(owner,spender)',
  '0x927da105': 'Permit2.allowance(user,token,spender)',
  '0xfeaf968c': 'latestRoundData',
  '0x7284e416': 'description',
  '0x313ce567': 'decimals',
  '0x95d89b41': 'symbol',
  '0x06fdde03': 'name',
  '0x82ad56cb': 'aggregate3',
}
const AGGREGATE3 = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'])

interface RpcCall { t: number; method: string; selectors: string[]; phase: string }

/** Every eth_call target selector in one JSON-RPC call, Multicall3 batches opened. */
function selectorsOf(call: { method?: string; params?: unknown[] }): string[] {
  if (call.method !== 'eth_call') return []
  const tx = (call.params?.[0] ?? {}) as { data?: Hex; input?: Hex }
  const data = (tx.data ?? tx.input ?? '0x') as Hex
  const sel = data.slice(0, 10)
  if (sel !== '0x82ad56cb') return [SELECTORS[sel] ?? sel]
  try {
    const { args } = decodeFunctionData({ abi: AGGREGATE3, data })
    return ['aggregate3', ...args[0].map((c) => SELECTORS[c.callData.slice(0, 10)] ?? c.callData.slice(0, 10))]
  } catch {
    return ['aggregate3(undecodable)']
  }
}

/** Busiest window of `ms` over the call timestamps (units = JSON-RPC calls, as the route charges them). */
function busiestWindow(calls: RpcCall[], ms: number): number {
  const ts = calls.map((c) => c.t).sort((a, b) => a - b)
  let best = 0
  for (let i = 0, j = 0; i < ts.length; i += 1) {
    while (ts[i] - ts[j] >= ms) j += 1
    best = Math.max(best, i - j + 1)
  }
  return best
}

const tally = (xs: string[]) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())].sort())

let upstream: Server
const upstreamMethods: string[] = []

test.beforeAll(async () => {
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
      const list = (Array.isArray(body) ? body : [body]) as Array<{ method?: string }>
      for (const b of list) upstreamMethods.push(`${chainId}:${b?.method}`)
      const answer = Array.isArray(body) ? body.map((b) => answerRpc(chainId, b)) : answerRpc(chainId, body as never)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((done) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', done))
})

test.afterAll(async () => {
  await new Promise<void>((done) => upstream.close(() => done()))
})

const UIS = [
  {
    ui: 'v1',
    baseURL: V1_URL,
    flip: (page: Page) => page.locator('button', { hasText: '⇅' }).first(),
    amount: (page: Page) => page.getByPlaceholder('0.0').first(),
    // The nav tab is also a button named "Swap": the CTA is the second one, once the quote and approval are ready.
    ctaReady: async (page: Page) => expect(page.getByRole('button', { name: /^Swap$/ })).toHaveCount(2, { timeout: 30_000 }),
    cta: (page: Page) => page.getByRole('button', { name: /^Swap$/ }).last(),
  },
  {
    ui: 'v2',
    baseURL: V2_URL,
    flip: (page: Page) => page.getByRole('button', { name: 'Swap sell and receive tokens' }).first(),
    amount: (page: Page) => page.getByRole('textbox', { name: 'Sell amount' }).first(),
    ctaReady: async () => {},
    cta: (page: Page) => page.getByRole('button', { name: /^Review swap$/ }).first(),
  },
] as const

/** /api/rpc → null (the real route, through rig.ts); /api/quote and the swap-adjacent routes → cow-flow.ts fixtures. */
const override: ApiOverride = (url, request) => (url.pathname === '/api/rpc' ? null : cowFlowOverride(url, request))

for (const { ui, baseURL, flip, amount, ctaReady, cta } of UIS) {
  test(`${ui} · mainnet session, wallet connected: balances, quote, allowance through the real /api/rpc; no console error; own origin only; under the rate limit`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const capture = new Capture(new URL(baseURL).origin)
    capture.apiOverride = override
    await capture.install(context)
    await installMockWallet(context) // starts on chain 0x1 (Ethereum) and reconnects on load

    const calls: RpcCall[] = []
    const hosts = new Set<string>()
    const statuses: number[] = []
    const rpcErrors: string[] = []
    let phase = 'load'
    // Registered after rig.ts's catch-all, so it runs first: record the JSON-RPC body, then hand over to the rig.
    await context.route('**/api/rpc*', async (route) => {
      let body: unknown
      try {
        body = route.request().postDataJSON()
      } catch {}
      const now = Date.now()
      for (const c of (Array.isArray(body) ? body : [body]) as Array<{ method?: string; params?: unknown[] }>) {
        calls.push({ t: now, method: String(c?.method ?? '?'), selectors: selectorsOf(c ?? {}), phase })
      }
      await route.fallback()
    })
    context.on('request', (r) => {
      try {
        const host = new URL(r.url()).host
        if (host) hosts.add(host) // data: / blob: have no host
      } catch {}
    })
    context.on('response', async (r) => {
      if (!new URL(r.url()).pathname.startsWith('/api/rpc')) return
      statuses.push(r.status())
      try {
        const json = await r.json()
        for (const one of Array.isArray(json) ? json : [json]) if (one?.error && one.error.message !== 'execution reverted') rpcErrors.push(String(one.error.message).slice(0, 120))
      } catch {}
    })

    const page = await context.newPage()
    await capture.installPage(page)
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240))
    })

    const t0 = Date.now()
    capture.phase = phase = 'load + connect'
    await page.goto(`${baseURL}/`, { waitUntil: 'load' })
    await settle(page, 3_000)
    await launchApp(page)
    await expect.poll(() => page.locator('header').first().innerText(), { message: 'the mock wallet reconnected', timeout: 15_000 }).toMatch(CONNECTED_LABEL)
    await settle(page, Math.max(0, 30_000 - (Date.now() - t0))) // the swap screen, connected, for its first 30 s
    const loadCalls = calls.length

    capture.phase = phase = 'quote'
    const tQuote = Date.now()
    await flip(page).click({ timeout: 8_000 })
    await settle(page, 1_000)
    await amount(page).fill('5') // 5 USDC → ETH: an ERC-20 sell, so the allowance gate is in play
    await ctaReady(page)
    await expect(cta(page), 'the swap CTA is ready: quote returned, balance and allowance gates passed').toBeEnabled({ timeout: 30_000 })
    const quoteMs = Date.now() - tQuote
    await settle(page, 5_000)
    const quoteCalls = calls.length - loadCalls

    capture.phase = phase = 'idle'
    await settle(page, Math.max(0, 90_000 - (Date.now() - t0))) // to 90 s: at least one full polling minute after load
    const sessionMs = Date.now() - t0

    const result = capture.result()
    await capture.close(context)

    const selectors = calls.flatMap((c) => c.selectors)
    const methods = calls.map((c) => c.method)
    const notAllowed = [...new Set(methods)].filter((m) => !allowedReadMethods(1).includes(m))
    const report = {
      ui,
      sessionSeconds: Math.round(sessionMs / 1000),
      hostsContacted: [...hosts].sort(),
      thirdParty: result.thirdParty,
      cspBlocked: result.cspBlocked,
      consoleErrors,
      pageErrors: capture.pageErrors,
      sameOriginApi: result.sameOriginApi,
      rpc: {
        units: { loadAndConnect30s: loadCalls, oneQuote: quoteCalls, wholeSession: calls.length, busiest60s: busiestWindow(calls, 60_000) },
        limit: RPC_RATE_LIMIT,
        quoteMs,
        byMethod: tally(methods),
        byPhase: tally(calls.map((c) => c.phase)),
        ethCallTargets: tally(selectors),
        statuses: tally(statuses.map(String)),
        refusals: result.rpcRefusals,
        jsonRpcErrors: rpcErrors,
        methodsNotOnChain1AllowList: notAllowed,
        chain1AllowList: allowedReadMethods(1),
        upstreamSaw: tally(upstreamMethods.splice(0)),
      },
    }
    if (process.env.SESSION_OUT) {
      mkdirSync(process.env.SESSION_OUT, { recursive: true })
      writeFileSync(join(process.env.SESSION_OUT, `mainnet-session-${ui}.json`), `${JSON.stringify(report, null, 1)}\n`)
    }

    // Own origin only: no provider, no marker host, no third party of any kind (HTTP or WebSocket).
    expect(report.hostsContacted, 'every host the browser contacted').toEqual([new URL(baseURL).host])
    for (const h of MARKER_HOSTS) expect(report.hostsContacted).not.toContain(h)
    expect(result.thirdParty, 'third-party hosts (HTTP or WS)').toEqual([])
    expect(result.cspBlocked, 'requests the CSP refused').toEqual({})
    expect([consoleErrors, capture.pageErrors], 'console errors and uncaught page errors').toEqual([[], []])
    // Mainnet only, through the bare /api/rpc (an absent chainId is mainnet).
    expect(Object.keys(result.sameOriginApi).filter((k) => k.startsWith('/api/rpc')), 'the proxy paths read').toEqual(['/api/rpc'])
    // Balances, allowance, quote.
    expect(selectors.filter((s) => s === 'balanceOf' || s === 'getEthBalance').length, 'balance reads through /api/rpc').toBeGreaterThan(0)
    expect(selectors.filter((s) => s.startsWith('allowance') || s.startsWith('Permit2.allowance')).length, 'allowance reads through /api/rpc').toBeGreaterThan(0)
    expect(result.sameOriginApi['/api/quote'] ?? 0, 'a quote was asked for and returned (the CTA above is enabled)').toBeGreaterThan(0)
    // The route served every call: allow-listed, never rate-limited, no JSON-RPC error but the stub's own reverts.
    expect(notAllowed, 'methods the mainnet client sent that are not on the chain-1 allow-list').toEqual([])
    expect(result.rpcRefusals, '/api/rpc answers that were not 200 (403 = allow-list, 429 = rate limit)').toEqual([])
    expect(report.rpc.statuses, 'every /api/rpc answer').toEqual({ 200: statuses.length })
    expect(rpcErrors).toEqual([])
    expect(RPC_RATE_LIMIT).toEqual({ limit: 300, windowMs: 60_000 })
    expect(report.rpc.units.busiest60s, 'busiest minute vs RPC_RATE_LIMIT (300 units / 60 s per client)').toBeLessThanOrEqual(RPC_RATE_LIMIT.limit)
  })
}
