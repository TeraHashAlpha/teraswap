/**
 * [A100, round 3] Shared pieces of the read-signature browser specs (foreign-entry.pw.ts, unrecoverable-signature.pw.ts).
 * Not a spec itself. Same discipline as account-switch.pw.ts: real Chromium, real CSP, production build, the REAL orders
 * and history routes on the PostgREST shim.
 *
 * The wallet stub holds THREE keys generated per run. A and B are ordinary accounts: the stub signs with the key of the
 * account `eth_signTypedData_v4` names in params[0], as an injected wallet does. An account listed in `unrecoverable`
 * answers with key C instead: a smart-contract-style account (Safe, Coinbase Smart Wallet), whose signature never recovers
 * to its own address. It can switch account (`__e2eSwitch` emits `accountsChanged`) and can start with an entry already in
 * sessionStorage (`plant`, written once per tab before the app's code runs).
 *
 * Every signature seen on the wire or in sessionStorage is classified here by RECOVERY ('own' = recovers to the wallet the
 * request names, 'OTHER' = to anyone else); no signature value is printed or written to a report.
 */
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Capture, launchApp, settle, type ApiOverride } from '../third-party-hosts/rig'
import { answerRpc, cowFlowOverride } from '../third-party-hosts/cow-flow'
import { buildOrdersReadTypedData } from '../../src/lib/order-engine/read-auth'
import { makeOrderRow } from '../../src/test-utils/orders-db-fixture'
import type { Row } from '../../src/test-utils/fake-postgrest'

export const KEYS = {
  A: privateKeyToAccount(generatePrivateKey()),
  B: privateKeyToAccount(generatePrivateKey()),
  C: privateKeyToAccount(generatePrivateKey()),
}
export const W = { A: KEYS.A.address.toLowerCase(), B: KEYS.B.address.toLowerCase(), C: KEYS.C.address.toLowerCase() }
export type Who = 'A' | 'B' | 'C' | '?' | '-'
export const who = (addr: unknown): Who => {
  const a = String(addr ?? '').toLowerCase()
  if (!a || a === 'null' || a === 'undefined') return '-'
  return a === W.A ? 'A' : a === W.B ? 'B' : a === W.C ? 'C' : '?'
}
export const headerLabel = (a: string) => new RegExp(`0x${a.slice(2, 4)}(${a.slice(4, 6)})?(…|\\.\\.\\.)${a.slice(-4)}`, 'i')
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'
const cacheKey = (wallet: string) => `teraswap:orders-read:${wallet}`

/** A DCA row owned by `owner`, in the shape the browser reads (`order_data` bigints as decimal strings). */
export function dca(rand: () => number, owner: string, over: Partial<Row> & { status: string; dca_total: number; dca_executed: number; created_at: string }): Row {
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86_400
  return makeOrderRow(rand, {
    wallet: owner, order_type: 'dca', chain_id: 1, token_in_symbol: 'USDC', token_out_symbol: 'WETH', token_in: USDC, token_out: WETH,
    token_in_decimals: 6, token_out_decimals: 18, amount_in: '100000000', min_amount_out: '0', target_price: '0', price_feed: ZERO, expiry,
    order_data: { owner, tokenIn: USDC, tokenOut: WETH, amountIn: '100000000', minAmountOut: '0', orderType: 2, condition: 0, targetPrice: '0',
      priceFeed: ZERO, expiry: String(expiry), nonce: '1', router: ZERO, routerDataHash: `0x${'00'.repeat(32)}`, dcaInterval: '3600', dcaTotal: String(over.dca_total) },
    ...over,
  })
}

/** The JSON-RPC stub `/api/rpc` reads from (the same answers as the third-party-hosts rig). */
export function startUpstream(port: number): Promise<Server> {
  const upstream = createServer((req, res) => {
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
  return new Promise((done) => upstream.listen(port, '127.0.0.1', () => done(upstream)))
}

export interface StoredEntry { key: string; value: string }
export interface WalletCfg {
  /** Accounts whose signature never recovers to them (key C answers): a smart-contract-style account. */
  unrecoverable: Array<'A' | 'B'>
}
export interface Prompt { phase: string; requested: Who; signedBy: Who; messageWallet: Who; primaryType: string }

async function installWallet(context: BrowserContext, prompts: Prompt[], phase: { v: string }, cfg: WalletCfg, plant: StoredEntry | null) {
  await context.exposeBinding('__e2eSign', async (_src, from: string, typedJson: string) => {
    const typed = JSON.parse(typedJson) as { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }
    const requested = who(from)
    const signedBy: Who = (requested === 'A' || requested === 'B') && cfg.unrecoverable.includes(requested) ? 'C' : requested
    prompts.push({ phase: phase.v, requested, signedBy, messageWallet: who(typed.message?.wallet), primaryType: typed.primaryType })
    if (signedBy !== 'A' && signedBy !== 'B' && signedBy !== 'C') throw new Error('unknown account')
    const { EIP712Domain: _domain, ...types } = typed.types
    const message: Record<string, unknown> = { ...typed.message }
    for (const f of types[typed.primaryType] ?? []) if (/^u?int/.test(f.type)) message[f.name] = BigInt(String(message[f.name]))
    return KEYS[signedBy].signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message } as never)
  })
  await context.addInitScript(({ a, plant }) => {
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
    const info = { uuid: '00000000-0000-4000-8000-0000000000a3', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
    ;(window as unknown as { ethereum: unknown }).ethereum = provider
    try {
      localStorage.setItem('wagmi.recentConnectorId', '"io.metamask"')
      localStorage.setItem('wagmi.io.metamask.connected', 'true')
      // Once per tab, before the app's code: an entry "already there" when this build loads.
      if (plant && !sessionStorage.getItem('e2e:planted')) {
        sessionStorage.setItem(plant.key, plant.value)
        sessionStorage.setItem('e2e:planted', '1')
      }
    } catch {}
  }, { a: KEYS.A.address, plant })
}

/** `by`'s signature over the read message naming `owner`, as the cache stores it (B over A = what an account-switch race left under A). */
export async function signedEntry(owner: 'A' | 'B', by: 'A' | 'B' | 'C'): Promise<StoredEntry> {
  const issuedAt = Math.floor(Date.now() / 1000)
  const signature = await KEYS[by].signTypedData(buildOrdersReadTypedData(W[owner], issuedAt))
  return { key: cacheKey(W[owner]), value: JSON.stringify({ issuedAt, signature }) }
}

export interface Call { phase: string; route: 'list' | 'poll' | 'executions' | 'history'; order: string; urlWallet: Who; sig: 'none' | 'own' | 'OTHER' | 'bad'; signer: Who; status: number }

export interface Probe {
  page: Page
  context: BrowserContext
  capture: Capture
  prompts: Prompt[]
  calls: Call[]
  phase: { v: string }
  result: Record<string, unknown>
  consoleErrors: string[]
}

const scrubConsole = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>').replace(/0x[0-9a-fA-F]{8,}/g, '0x…').slice(0, 160)

/** One fresh browser context: wallet stub, capture, the real orders/history routes, and a recorder of every orders read. */
export async function openProbe(browser: Browser, baseURL: string, cfg: WalletCfg, orderLabels: Record<string, string>, plant: StoredEntry | null = null): Promise<Probe> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' })
  const prompts: Prompt[] = []
  const phase = { v: 'P1' }
  const origin = new URL(baseURL).origin
  const capture = new Capture(origin)
  const override: ApiOverride = (url, request) => (url.pathname === '/api/rpc' ? null : cowFlowOverride(url, request))
  capture.apiOverride = override
  await capture.install(context)
  // Registered AFTER the capture's catch-all, so it runs first: the orders and history routes are the REAL ones.
  await context.route(/\/api\/(orders|history)(\/|\?|$)/, (route) => route.continue())
  await installWallet(context, prompts, phase, cfg, plant)
  const page = await context.newPage()
  await capture.installPage(page)
  const calls: Call[] = []
  const consoleErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${phase.v}: ${scrubConsole(m.text())}`)
  })
  page.on('pageerror', (e) => consoleErrors.push(`${phase.v}: pageerror: ${scrubConsole(String(e))}`))
  page.on('response', async (res) => {
    const u = new URL(res.url())
    if (u.origin !== origin) return
    const exec = /^\/api\/orders\/([^/]+)\/executions$/.exec(u.pathname)
    let route: Call['route'] | null = null
    if (exec) route = 'executions'
    else if (u.pathname === '/api/orders') route = u.searchParams.get('hashes') ? 'poll' : 'list'
    else if (u.pathname === '/api/history') route = 'history'
    if (!route) return
    const at = phase.v
    const h = res.request().headers()
    const urlWallet = (u.searchParams.get('wallet') ?? '').toLowerCase()
    let sig: Call['sig'] = 'none'
    let signer: Who = '-'
    if (h['x-orders-read-signature']) {
      try {
        const rec = await recoverTypedDataAddress({ ...buildOrdersReadTypedData(urlWallet, Number.parseInt(h['x-orders-read-issued'] ?? '0', 10)), signature: h['x-orders-read-signature'] as `0x${string}` })
        signer = who(rec)
        sig = rec.toLowerCase() === urlWallet ? 'own' : 'OTHER'
      } catch {
        sig = 'bad'
      }
    }
    calls.push({ phase: at, route, order: exec ? (orderLabels[exec[1]] ?? 'other') : '-', urlWallet: who(urlWallet), sig, signer, status: res.status() })
  })
  return { page, context, capture, prompts, calls, phase, result: {}, consoleErrors }
}

/** Write the scenario's report (ORDERS_E2E_OUT, when set), then close. Returns the prompts per phase. */
export async function closeProbe(p: Probe, name: string): Promise<Record<string, number>> {
  const promptsByPhase: Record<string, number> = {}
  for (const x of p.prompts) promptsByPhase[x.phase] = (promptsByPhase[x.phase] ?? 0) + 1
  const out = { name, tree: process.env.CAPTURE_APP_DIR ? 'CAPTURE_APP_DIR' : 'this tree', ...p.result, promptsByPhase, prompts: p.prompts, calls: p.calls, consoleErrors: p.consoleErrors }
  if (process.env.ORDERS_E2E_OUT) {
    mkdirSync(process.env.ORDERS_E2E_OUT, { recursive: true })
    writeFileSync(join(process.env.ORDERS_E2E_OUT, `${name}.json`), `${JSON.stringify(out, null, 1)}\n`)
    await p.page.screenshot({ path: join(process.env.ORDERS_E2E_OUT, `${name}-end.png`), fullPage: true }).catch(() => {})
  }
  await p.capture.close(p.context).catch(() => {})
  return promptsByPhase
}

export const txLinks = (page: Page, hashes: string[]) =>
  page.evaluate((hs) => hs.filter((x) => [...document.querySelectorAll('a[href]')].some((a) => (a as HTMLAnchorElement).href.toLowerCase().includes(x.toLowerCase()))).length, hashes)
export const headerText = (page: Page) => page.locator('header').first().innerText().catch(() => '')
export const switchTo = (page: Page, addr: string) => page.evaluate((x) => (window as unknown as { __e2eSwitch: (a: string) => void }).__e2eSwitch(x), addr)
/** Push the entry cached under `wallet` past the client's 23 h 59 m window (the 24 h TTL minus its 60 s margin). */
export const ageCache = (page: Page, wallet: string) =>
  page.evaluate((k) => {
    const raw = sessionStorage.getItem(k)
    if (!raw) return 'absent'
    const v = JSON.parse(raw)
    v.issuedAt = Math.floor(Date.now() / 1000) - 86_341
    sessionStorage.setItem(k, JSON.stringify(v))
    return 'aged'
  }, cacheKey(wallet))
export const plantNow = (page: Page, e: StoredEntry) => page.evaluate((x) => sessionStorage.setItem(x.key, x.value), e)
/** The raw entry cached under `wallet` (kept in this process only, to hand to another tab; never printed). */
export const readEntry = async (page: Page, wallet: string): Promise<StoredEntry | null> => {
  const value = await page.evaluate((k) => sessionStorage.getItem(k), cacheKey(wallet))
  return value ? { key: cacheKey(wallet), value } : null
}
/** Who signed the entry cached under `wallet`: 'absent', a known account, '?' (nobody known: e.g. an aged entry), or 'bad'. */
export async function cacheSignerOf(page: Page, wallet: string): Promise<Who | 'absent' | 'bad'> {
  const raw = await page.evaluate((k) => sessionStorage.getItem(k), cacheKey(wallet))
  if (!raw) return 'absent'
  const v = JSON.parse(raw)
  try {
    return who(await recoverTypedDataAddress({ ...buildOrdersReadTypedData(wallet, v.issuedAt), signature: v.signature }))
  } catch {
    return 'bad'
  }
}
export const signToView = (page: Page) => page.getByRole('button', { name: /^sign to view$/i }).first()

export async function connectAndOpenOrders(page: Page, ui: 'v1' | 'v2', baseURL: string) {
  await page.goto(`${baseURL}${ui === 'v2' ? '/orders' : '/'}`, { waitUntil: 'load' })
  await settle(page, 3_000)
  await launchApp(page)
  if (ui === 'v1') await page.getByRole('button', { name: /^Orders$/ }).first().click({ timeout: 10_000 })
}
export const tab = (page: Page, ui: 'v1' | 'v2', name: 'swap' | 'orders') =>
  ui === 'v2' ? page.locator(`[data-tab-id="${name}"]`).first() : page.getByRole('button', { name: name === 'swap' ? /^Swap$/ : /^Orders$/ }).first()

export { settle }
