/**
 * [ADR-025 / feat/ui-v2-mobile-parity] Real-render rig for the v2 mobile (375) gates: a mocked browser wallet (EIP-6963) and a mocked
 * network, so every v2 route can be loaded in real Chromium with the SAME fixtures the vitest parity suites use. Nothing here signs, sends
 * or leaves the machine: every request that is not the app's own origin is aborted, `/api/**` is answered from fixtures, `/api/rpc` is a
 * JSON-RPC stub, and the "wallet" returns a canned signature.
 *
 * Playwright, not vitest: layout (overflow, tap-target size, sticky/bottom-sheet geometry) does not exist in jsdom. Files are `*.pw.ts` so
 * vitest's `*.test.ts(x)` discovery never picks them up. Run: `npx playwright test --config src/ui/v2/__tests__/mobile/playwright.config.ts`
 * against `next start` (UI_V2_ENABLED=true) — see playwright.config.ts.
 */
import type { BrowserContext, Page, Route } from '@playwright/test'
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem'
import { DASHBOARD, PERSONAL, STATS } from '../../analytics/analytics-fixtures'
import { ALL_ORDERS, FILLS, ORDER_META, PRICES } from '../../dca/positions-fixtures'
import type { AutonomousOrder } from '@/lib/order-engine'

export const WALLET = '0xd44d00000000000000000000000000000000962d'
export const SIG = `0x${'11'.repeat(65)}`

/** What a route needs: a wallet on `chainId`, or no wallet at all. */
export interface Scenario {
  chainId: number
  connected: boolean
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`

/** The EIP-6963 mock wallet, installed before any page script runs. Reconnects wagmi through `recentConnectorId`. */
export async function installWallet(context: BrowserContext, s: Scenario) {
  if (!s.connected) return
  await context.addInitScript(
    ({ wallet, chainHex, sig }) => {
      let chain = chainHex
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
      const provider = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [wallet]
            case 'eth_chainId':
              return chain
            case 'net_version':
              return String(parseInt(chain, 16))
            case 'wallet_switchEthereumChain': {
              chain = (params?.[0] as { chainId: string }).chainId
              for (const l of listeners.chainChanged ?? []) l(chain)
              return null
            }
            case 'personal_sign':
            case 'eth_signTypedData_v4':
              return sig
            default:
              return null
          }
        },
        on: (e: string, l: (...a: unknown[]) => void) => void (listeners[e] ??= []).push(l),
        removeListener: (e: string, l: (...a: unknown[]) => void) => void (listeners[e] = (listeners[e] ?? []).filter((x) => x !== l)),
      }
      const info = { uuid: '00000000-0000-4000-8000-000000000001', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
      ;(window as unknown as { ethereum: unknown }).ethereum = provider
      try {
        localStorage.setItem('wagmi.recentConnectorId', '"io.metamask"')
        localStorage.setItem('wagmi.io.metamask.connected', 'true')
      } catch {}
    },
    { wallet: WALLET, chainHex: hex(s.chainId), sig: SIG },
  )
}

/** v1's AutonomousOrder → the Supabase row `/api/orders` returns (the inverse of useOrderEngine's `rowToOrder`). */
function toRow(o: AutonomousOrder) {
  const json = JSON.parse(JSON.stringify(o.order, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
  return {
    id: o.id,
    wallet: WALLET,
    order_hash: o.orderHash,
    order_type: o.orderType === 0 ? 'limit' : o.orderType === 1 ? 'stop_loss' : 'dca',
    status: o.status === 'filled' ? 'executed' : o.status,
    chain_id: o.chainId ?? 1,
    token_in: o.order.tokenIn,
    token_out: o.order.tokenOut,
    token_in_symbol: o.tokenInSymbol,
    token_out_symbol: o.tokenOutSymbol,
    token_in_decimals: o.tokenInDecimals,
    token_out_decimals: o.tokenOutDecimals,
    floor_tier: o.floorTier ?? null,
    amount_in: o.order.amountIn.toString(),
    min_amount_out: o.order.minAmountOut.toString(),
    target_price: o.order.targetPrice.toString(),
    price_feed: o.order.priceFeed,
    expiry: String(Math.floor(o.expiresAt / 1000)),
    nonce: Number(o.order.nonce),
    router: o.order.router,
    dca_interval: Number(o.order.dcaInterval ?? 0),
    dca_total: o.dcaTotal,
    dca_executed: o.dcaExecuted,
    signature: o.signature,
    order_data: json,
    tx_hash: o.txHash ?? null,
    amount_out: o.amountOut ?? null,
    error: o.error ?? null,
    created_at: new Date(o.createdAt).toISOString(),
    executed_at: o.executedAt ? new Date(o.executedAt).toISOString() : null,
  }
}

const TOKEN = (symbol: string, address: string, decimals: number, balance: string) => ({ address, symbol, name: symbol, decimals, logoURI: null, balance, isDefault: false })

/** The fixture answers, keyed by pathname. */
function answer(pathname: string, url: URL, s: Scenario): unknown {
  if (pathname === '/api/orders') return { orders: ALL_ORDERS.map(toRow) }
  const ex = /^\/api\/orders\/([^/]+)\/executions$/.exec(pathname)
  if (ex) return { executions: FILLS[ex[1]] ?? [], order: ORDER_META[ex[1]] ?? null }
  if (pathname === '/api/portfolio/prices') return { prices: { '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': 2489.11, ...PRICES } }
  if (pathname === '/api/portfolio/tokens') {
    return { tokens: [TOKEN('USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, '1250420000'), TOKEN('WETH', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 18, '420000000000000000'), TOKEN('LONGSYMBOLTOKEN', '0x1111111111111111111111111111111111111111', 18, '12345678901234567890123')] }
  }
  if (pathname === '/api/history') {
    const rows = Array.from({ length: 6 }, (_, i) => ({ kind: i === 2 ? 'dca_fill' : 'swap', id: `h${i}`, tx_hash: `0x${(i + 1).toString(16).repeat(64).slice(0, 64)}`, source: i === 2 ? 'teraswap_order_engine' : 'velora', token_in_symbol: 'ETH', token_out_symbol: 'USDC', amount_in: '700000000000000', amount_out: '1718300', amount_in_usd: 1.72, status: 'confirmed', created_at: new Date(Date.now() - i * 3_600_000).toISOString(), chain_id: [1, 8453, 42161][i % 3] }))
    return { swaps: rows, total: 62 }
  }
  if (pathname === '/api/analytics') return DASHBOARD
  if (pathname === '/api/analytics/personal') return PERSONAL
  if (pathname === '/api/stats') return STATS
  if (pathname === '/api/quote') {
    const q = url.searchParams
    const human = Number(q.get('amount')) / 10 ** Number(q.get('srcDecimals') ?? 18) // the fixture rates are per 1 ETH → USDC
    const meta = JSON.parse(JSON.stringify(quoteMeta(human)))
    return { ...meta, tokenIn: q.get('src'), tokenOut: q.get('dst'), chainId: Number(q.get('chainId') ?? 1), decimalsIn: Number(q.get('srcDecimals')), decimalsOut: Number(q.get('dstDecimals')), amountIn: q.get('amount') }
  }
  if (pathname === '/api/spender') return { spender: '0x6a000f20005980200259b80c5102003040001068' }
  void s
  return {}
}

const q = (source: string, usdc: number, extra: Record<string, unknown> = {}) => ({ source, toAmount: String(Math.round(usdc * 1e6)), estimatedGas: 210_000, gasUsd: 0.03, routes: [], ...extra })
function quoteMeta(scale = 1) {
  const all = [q('velora', 2487.6842 * scale, { routes: ['Dexalot', 'PancakeSwap V3', 'Dexalot'] }), q('kyberswap', 2487.0295 * scale), q('sushiswap', 2485.7878 * scale), q('uniswapv3', 2485.4736 * scale), q('0x', 2480.9321 * scale)]
  return { best: all[0], all, fetchedAt: Date.now() }
}

const MULTICALL = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])'])
const FEED = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function decimals() view returns (uint8)', 'function description() view returns (string)', 'function getEthBalance(address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'])
/** The ETH/USD feeds (mainnet, Base, Arbitrum): $2 489.11. Every other feed the app reads is a stablecoin: $1.00. */
const ETH_FEEDS = new Set(['0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70', '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612'])

/** What a Chainlink feed answers: a fresh round at the price above, 8 decimals. Anything else is a zero word. */
function feedCall(target: string, data: Hex): Hex {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const price = ETH_FEEDS.has(target.toLowerCase()) ? 248_911_000_000n : 100_000_000n
  try {
    const { functionName } = decodeFunctionData({ abi: FEED, data })
    if (functionName === 'latestRoundData') return encodeFunctionResult({ abi: FEED, functionName, result: [1n, price, now, now, 1n] })
    if (functionName === 'getEthBalance') return encodeFunctionResult({ abi: FEED, functionName, result: 1_358_000_000_000_000n })
    if (functionName === 'balanceOf') return encodeFunctionResult({ abi: FEED, functionName, result: 1_000_000_000_000_000_000_000n })
    if (functionName === 'decimals') return encodeFunctionResult({ abi: FEED, functionName, result: 8 })
    if (functionName === 'description') return encodeFunctionResult({ abi: FEED, functionName, result: ETH_FEEDS.has(target.toLowerCase()) ? 'ETH / USD' : 'USDC / USD' })
  } catch {}
  return `0x${'0'.repeat(64)}`
}

/** `eth_call`: Multicall3.aggregate3 (wagmi batches reads through it) or a direct feed read. */
function ethCall(call: { to?: string; data?: Hex }): Hex {
  const data = call.data ?? '0x'
  try {
    const { functionName, args } = decodeFunctionData({ abi: MULTICALL, data })
    if (functionName === 'aggregate3') {
      const results = (args[0] as ReadonlyArray<{ target: string; callData: Hex }>).map((c) => ({ success: true, returnData: feedCall(c.target, c.callData) }))
      return encodeFunctionResult({ abi: MULTICALL, functionName, result: results })
    }
  } catch {}
  return feedCall(call.to ?? '0x', data)
}

/** A JSON-RPC stub (`/api/rpc`): chain id, a block, a balance, and zeros for every `eth_call` (reads decode to "nothing here"). */
function rpc(body: unknown, chainId: number): unknown {
  const one = (r: { id?: number; method?: string; params?: unknown }) => {
    const result = r.method === 'eth_chainId' ? hex(chainId) : r.method === 'eth_blockNumber' ? hex(23_541_870) : r.method === 'eth_getBalance' ? hex(1_358_000_000_000_000n) : r.method === 'eth_call' ? ethCall((r as { params?: [{ to?: string; data?: Hex }] }).params?.[0] ?? {}) : r.method === 'eth_gasPrice' ? hex(100_000_000) : null
    return { jsonrpc: '2.0', id: r.id ?? 1, result }
  }
  return Array.isArray(body) ? body.map(one) : one(body as { id?: number; method?: string })
}

/** Network isolation + fixtures for one page: nothing leaves the machine, `/api/**` and `/api/rpc` are answered locally. */
export async function installNetwork(page: Page, origin: string, s: Scenario) {
  const host = new URL(origin).host
  /** The chain an RPC endpoint answers for: `/api/rpc` is mainnet's proxy; the L2 clients dial their public endpoints directly. */
  const chainOf = (url: URL) => (/base/i.test(url.host) ? 8453 : /arb/i.test(url.host) ? 42161 : 1)
  const jsonRpc = (route: Route, chainId: number) => {
    let body: unknown = {}
    try {
      body = route.request().postDataJSON()
    } catch {}
    if (process.env.V2_DEBUG) console.log(`[rpc ${chainId}] ${JSON.stringify(Array.isArray(body) ? body.map((b: { method?: string }) => b.method) : (body as { method?: string }).method)}`)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rpc(body, chainId)) })
  }
  await page.route('**/*', (route: Route) => {
    const url = new URL(route.request().url())
    if (url.host !== host) {
      // the L2 RPC endpoints are JSON-RPC POSTs: answered by the stub; everything else off-origin never leaves the machine
      return route.request().method() === 'POST' && /"jsonrpc"/.test(route.request().postData() ?? '') ? jsonRpc(route, chainOf(url)) : route.abort()
    }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    if (url.pathname === '/api/rpc') return jsonRpc(route, 1)
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(url.pathname, url, s)) })
  })
}
