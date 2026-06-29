import { NextResponse } from 'next/server'
import { getSupabase } from '@/lib/supabase'

/**
 * GET /api/analytics
 *
 * Server-side analytics dashboard data.
 * Queries the `swaps` table (real transaction data) and computes
 * all metrics needed by the AnalyticsDashboard component.
 *
 * This replaces the broken client-side analytics-tracker approach
 * which tried to use localStorage + a non-existent `trade_events` table.
 */
export async function GET() {
  const supabase = getSupabase()

  if (!supabase) {
    // Return empty dashboard so the UI still renders gracefully
    return NextResponse.json({ enabled: false, dashboard: emptyDashboard() })
  }

  try {
    // Fetch only confirmed swaps for volume/fee metrics.
    // Excludes: pending (not yet mined or user cancelled), failed, abandoned.
    // This ensures cancelled wallet rejections are never counted as volume.
    //
    // [CHORE-ANALYTICS-DCA-EXECUTIONS] In parallel, fetch confirmed conditional-
    // order fills (DCA / limit / stop-loss) from order_executions. Keeper-driven
    // executions never flow through /api/log-swap, so they are absent from the
    // `swaps` table; merging them in here (vs the keeper writing a swaps row)
    // gives automatic backfill of already-executed chunks with no contract or
    // keeper change. The execution fetch is fail-soft: any error returns [] so a
    // problem there never regresses instant-swap analytics.
    const [{ data: swaps, error }, executions] = await Promise.all([
      supabase
        .from('swaps')
        .select('*')
        .eq('status', 'confirmed')
        .order('created_at', { ascending: false })
        .limit(5000),
      fetchConfirmedExecutions(supabase),
    ])

    if (error) {
      console.error('[analytics] Failed to query swaps:', error.message)
      return NextResponse.json({ enabled: true, dashboard: emptyDashboard(), error: error.message })
    }

    if ((!swaps || swaps.length === 0) && executions.length === 0) {
      return NextResponse.json({ enabled: true, dashboard: emptyDashboard() })
    }

    const dashboard = computeDashboard(swaps ?? [], executions)
    return NextResponse.json(
      { enabled: true, dashboard },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
        },
      },
    )
  } catch (err) {
    console.error('[analytics] Error:', err)
    return NextResponse.json({ enabled: false, dashboard: emptyDashboard() })
  }
}

/**
 * [CHORE-ANALYTICS-DCA-EXECUTIONS] Fetch confirmed conditional-order fills with
 * their parent order embedded (wallet, token pair, chain, router live on the
 * order). Selects only columns that reliably exist (the live order_executions
 * table has diverged from contracts/order-engine/schema.sql — the keeper omits
 * execution_number/fee_amount and adds executed_at). Fail-soft: any error or
 * unconfigured client returns [] so instant-swap analytics never regress.
 */
async function fetchConfirmedExecutions(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
): Promise<Record<string, unknown>[]> {
  try {
    const { data, error } = await supabase
      .from('order_executions')
      .select(
        'id,created_at,tx_hash,amount_in,amount_out,status,order_id,' +
          'orders(wallet,order_type,token_in,token_in_symbol,token_out,token_out_symbol,chain_id,router,dca_total,amount_in)',
      )
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(5000)

    if (error) {
      console.error('[analytics] order_executions query failed:', error.message)
      return []
    }
    return (data as unknown as Record<string, unknown>[]) ?? []
  } catch (err) {
    console.error('[analytics] order_executions query error:', err)
    return []
  }
}

// ── Types matching DashboardData from analytics-types.ts ──

interface PeriodMetrics {
  totalVolume: number
  totalFees: number
  tradeCount: number
  uniqueWallets: number
}

interface SourceMetrics {
  source: string
  tradeCount: number
  volumeUsd: number
  winRate: number
}

interface PairMetrics {
  pair: string
  tradeCount: number
  volumeUsd: number
}

interface TradeEvent {
  id: string
  type: string
  wallet: string
  timestamp: number
  hour: number
  tokenIn: string
  tokenInAddress: string
  tokenOut: string
  tokenOutAddress: string
  amountIn: string
  amountOut: string
  volumeUsd: number
  feeUsd: number
  source: string
  txHash: string
  chainId: number
}

interface DashboardResponse {
  allTime: PeriodMetrics
  last24h: PeriodMetrics
  last7d: PeriodMetrics
  last30d: PeriodMetrics
  bySource: SourceMetrics[]
  byHour: Array<{ hour: number; volumeUsd: number; tradeCount: number }>
  topPairs: PairMetrics[]
  totalWallets: number
  recentTrades: TradeEvent[]
  dailyVolume: Array<{ date: string; volumeUsd: number; tradeCount: number }>
}

// ── Helpers ──

function emptyPeriod(): PeriodMetrics {
  return { totalVolume: 0, totalFees: 0, tradeCount: 0, uniqueWallets: 0 }
}

function emptyDashboard(): DashboardResponse {
  return {
    allTime: emptyPeriod(),
    last24h: emptyPeriod(),
    last7d: emptyPeriod(),
    last30d: emptyPeriod(),
    bySource: [],
    byHour: Array.from({ length: 24 }, (_, i) => ({ hour: i, volumeUsd: 0, tradeCount: 0 })),
    topPairs: [],
    totalWallets: 0,
    recentTrades: [],
    dailyVolume: [],
  }
}

// Token decimals for converting raw wei to human-readable amounts
const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18, WETH: 18, stETH: 18, wstETH: 18, cbETH: 18, rETH: 18,
  USDC: 6, USDT: 6,
  DAI: 18, FRAX: 18, LUSD: 18, sUSD: 18, crvUSD: 18, GHO: 18, PYUSD: 6,
  WBTC: 8, renBTC: 8, tBTC: 18,
  UNI: 18, LINK: 18, AAVE: 18, MKR: 18, SNX: 18, CRV: 18, LDO: 18,
  COMP: 18, BAL: 18, SUSHI: 18, '1INCH': 18, MATIC: 18, ARB: 18, OP: 18,
}

// Approximate USD prices for volume estimation when amount_in_usd is null
// [CHORE-DCA-POSITIONS-DASHBOARD] Keys UPPERCASE to match the toUpperCase() lookup in
// estimateUsdValue — mixed-case literals (stETH, cbETH, …) were dead keys that never resolved.
const APPROX_PRICES: Record<string, number> = {
  ETH: 3500, WETH: 3500, STETH: 3500, WSTETH: 4000, CBETH: 3600, RETH: 3800,
  USDC: 1, USDT: 1, DAI: 1, FRAX: 1, LUSD: 1, SUSD: 1, CRVUSD: 1, GHO: 1, PYUSD: 1,
  WBTC: 95000, RENBTC: 95000, TBTC: 95000,
  UNI: 12, LINK: 18, AAVE: 200, MKR: 1500, CRV: 0.5, LDO: 2,
}

function rawToHuman(rawVal: string, symbol: string): number {
  try {
    const decimals = TOKEN_DECIMALS[symbol?.toUpperCase()] ?? 18
    const intPart = rawVal.split('.')[0]
    return Number(BigInt(intPart)) / Math.pow(10, decimals)
  } catch {
    return Number(rawVal) || 0
  }
}

function estimateUsdValue(rawAmount: string, symbol: string): number {
  const human = rawToHuman(rawAmount, symbol)
  const price = APPROX_PRICES[symbol?.toUpperCase()] ?? 0
  return human * price
}

/** Convert a Supabase swap row into a TradeEvent for the dashboard */
function swapToEvent(row: Record<string, unknown>): TradeEvent {
  const createdAt = row.created_at ? new Date(row.created_at as string) : new Date()
  const ts = createdAt.getTime()

  const tokenInSymbol = (row.token_in_symbol as string) || ''
  const tokenOutSymbol = (row.token_out_symbol as string) || ''
  const rawAmountIn = (row.amount_in as string) || '0'
  const rawAmountOut = (row.amount_out as string) || '0'

  // Use stored USD if available, otherwise estimate from raw wei + approximate prices
  const storedUsd = Number(row.amount_in_usd) || 0
  const volumeUsd = storedUsd > 0
    ? storedUsd
    : estimateUsdValue(rawAmountIn, tokenInSymbol)

  // Fee: 0.1% of volume
  const feeCollected = row.fee_collected as boolean
  const feeUsd = feeCollected ? volumeUsd * 0.001 : 0

  // Convert raw wei to human-readable for display
  const humanIn = rawToHuman(rawAmountIn, tokenInSymbol)
  const humanOut = rawToHuman(rawAmountOut, tokenOutSymbol)

  return {
    id: row.id as string,
    type: 'swap',
    wallet: row.wallet as string,
    timestamp: ts,
    hour: createdAt.getUTCHours(),
    tokenIn: tokenInSymbol,
    tokenInAddress: (row.token_in as string) || '',
    tokenOut: tokenOutSymbol,
    tokenOutAddress: (row.token_out as string) || '',
    amountIn: humanIn.toString(),
    amountOut: humanOut.toString(),
    volumeUsd,
    feeUsd,
    source: (row.source as string) || 'unknown',
    txHash: (row.tx_hash as string) || '',
    chainId: Number(row.chain_id) || 1,
  }
}

// ── [CHORE-ANALYTICS-DCA-EXECUTIONS] Conditional-order executions ──
//
// order_executions rows reference an `orders` row (embedded via the order_id
// FK) for everything the swaps table carries inline: wallet, token pair, chain,
// and the committed router. We surface these executions as analytics trades so
// real protocol volume from DCA / limit / stop-loss fills is no longer invisible.

// Committed router address → instant-swap source name, so a Velora DCA fill
// buckets together with instant `velora` swaps in Best Routes. MUST mirror
// contracts/order-engine/executor/swap-route.js `ROUTER_SOURCE` and the
// per-chain whitelist in src/lib/order-engine/config.ts. Keyed lowercased
// (addresses are globally unique → chain-agnostic).
const ROUTER_TO_SOURCE: Record<string, string> = {
  // Base (8453)
  '0x6a000f20005980200259b80c5102003040001068': 'velora',     // ParaSwap/Velora Augustus V6
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'uniswapv3',  // Uniswap SwapRouter02
  // Mainnet (1)
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',      // 1inch v6
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x',         // 0x Exchange Proxy
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57': 'velora',     // Augustus v5 (ParaSwap) → group with velora
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'uniswapv3',  // Uniswap V3 SwapRouter
}

// orders.order_type → the dashboard's TradeType (analytics-types.ts). The
// AnalyticsDashboard ActivityFeed already renders these labels/colours.
const ORDER_TYPE_EVENT: Record<string, string> = {
  dca: 'dca_buy',
  limit: 'limit_fill',
  stop_loss: 'sltp_trigger',
}

/**
 * Per-execution gross input amount, in raw token units.
 * The keeper records the FULL signed order amount on every execution row
 * (executor.js recordExecution → dbOrder.amount_in), so a single chunk is
 * orders.amount_in / dca_total. For limit/stop-loss orders dca_total is 1, so
 * this is the full amount (one execution). BigInt floor division, string in/out.
 */
function perChunkAmount(amountInRaw: unknown, dcaTotal: number): string {
  try {
    const total = BigInt(String(amountInRaw ?? '0').split('.')[0] || '0')
    const n = BigInt(Math.max(Math.floor(dcaTotal) || 1, 1))
    return (total / n).toString()
  } catch {
    // Non-numeric amount_in (DB stores it as free TEXT). Fall back to 0 — the
    // execution still counts as a trade but contributes $0, the same as an
    // instant swap with an unpriceable token. Warn so silent data corruption is
    // visible in logs rather than vanishing into a zero-volume row.
    console.warn('[analytics] perChunkAmount: invalid amount_in', { amountInRaw, dcaTotal })
    return '0'
  }
}

/**
 * Convert an order_executions row (with its `orders` parent embedded) into a
 * TradeEvent. Returns null when the parent order didn't embed (can't value or
 * attribute it). USD volume uses the SAME estimateUsdValue path swaps fall back
 * to — no fabrication, no stored USD invented.
 */
export function executionToEvent(row: Record<string, unknown>): TradeEvent | null {
  const orderRaw = (row as { orders?: unknown }).orders
  const order = (Array.isArray(orderRaw) ? orderRaw[0] : orderRaw) as
    | Record<string, unknown>
    | null
    | undefined
  if (!order) return null

  const createdAt = row.created_at ? new Date(row.created_at as string) : new Date()
  const ts = createdAt.getTime()

  const tokenInSymbol = (order.token_in_symbol as string) || ''
  const tokenOutSymbol = (order.token_out_symbol as string) || ''
  const dcaTotal = Math.max(Number(order.dca_total) || 1, 1)
  const chunkRaw = perChunkAmount(order.amount_in, dcaTotal)

  const volumeUsd = estimateUsdValue(chunkRaw, tokenInSymbol)
  const humanIn = rawToHuman(chunkRaw, tokenInSymbol)

  const router = ((order.router as string) || '').toLowerCase()
  const orderType = (order.order_type as string) || ''

  return {
    id: (row.id as string) || (row.tx_hash as string) || '',
    type: ORDER_TYPE_EVENT[orderType] || 'order',
    wallet: (order.wallet as string) || '',
    timestamp: ts,
    hour: createdAt.getUTCHours(),
    tokenIn: tokenInSymbol,
    tokenInAddress: (order.token_in as string) || '',
    tokenOut: tokenOutSymbol,
    tokenOutAddress: (order.token_out as string) || '',
    amountIn: humanIn.toString(),
    // The keeper does not parse output logs (execution.amount_out is '0'), so we
    // leave the per-chunk output blank rather than display a wrong/zero figure.
    amountOut: '',
    volumeUsd,
    // Order fees are taken on-chain; we don't have a confirmed per-chunk fee and
    // won't fabricate one. Fees aren't a dashboard KPI, so 0 is safe here.
    feeUsd: 0,
    source: ROUTER_TO_SOURCE[router] || 'order',
    txHash: (row.tx_hash as string) || '',
    chainId: Number(order.chain_id) || 1,
  }
}

function filterByPeriod(events: TradeEvent[], ms: number): TradeEvent[] {
  const cutoff = Date.now() - ms
  return events.filter(e => e.timestamp >= cutoff)
}

function computePeriodMetrics(events: TradeEvent[]): PeriodMetrics {
  const wallets = new Set(events.map(e => e.wallet))
  return {
    totalVolume: events.reduce((s, e) => s + e.volumeUsd, 0),
    totalFees: events.reduce((s, e) => s + e.feeUsd, 0),
    tradeCount: events.length,
    uniqueWallets: wallets.size,
  }
}

/**
 * [CHORE-ANALYTICS-DCA-EXECUTIONS] Merge instant swaps with conditional-order
 * executions into a single, de-duplicated, newest-first event stream, then
 * aggregate. Executions are valued by the SAME functions as swaps (see
 * executionToEvent → estimateUsdValue), never fabricated. A tx that somehow
 * appears in both tables is counted exactly once (the swaps row wins), so
 * volume / trade counts can never double-count.
 */
export function computeDashboard(
  swaps: Record<string, unknown>[],
  executions: Record<string, unknown>[],
): DashboardResponse {
  const swapEvents = swaps.map(swapToEvent)
  const execEvents = executions
    .map(executionToEvent)
    .filter((e): e is TradeEvent => e !== null)

  const seenTx = new Set<string>()
  const events: TradeEvent[] = []
  // Swaps first so a tx present in both tables resolves to the swap row.
  for (const e of [...swapEvents, ...execEvents]) {
    if (e.txHash) {
      if (seenTx.has(e.txHash)) continue
      seenTx.add(e.txHash)
    }
    events.push(e)
  }
  events.sort((a, b) => b.timestamp - a.timestamp)

  return buildDashboard(events)
}

function buildDashboard(events: TradeEvent[]): DashboardResponse {
  // Period metrics
  const allTime = computePeriodMetrics(events)
  const last24h = computePeriodMetrics(filterByPeriod(events, 24 * 60 * 60 * 1000))
  const last7d = computePeriodMetrics(filterByPeriod(events, 7 * 24 * 60 * 60 * 1000))
  const last30d = computePeriodMetrics(filterByPeriod(events, 30 * 24 * 60 * 60 * 1000))

  // Source metrics. tradeCount + volume include every event (so order
  // executions show up in Best Routes), but `winRate` keeps its original
  // meaning — "% of times this source won the QUOTE" — by using a swaps-only
  // numerator and denominator. Conditional-order fills have no quote contest to
  // win, so they neither inflate nor dilute win rates: instant-swap win-rate
  // numbers are byte-identical to before this change. [CHORE-ANALYTICS-DCA-EXECUTIONS]
  const sourceMap = new Map<string, { count: number; volume: number; swapCount: number }>()
  let swapTotal = 0
  for (const e of events) {
    const entry = sourceMap.get(e.source) || { count: 0, volume: 0, swapCount: 0 }
    entry.count++
    entry.volume += e.volumeUsd
    if (e.type === 'swap') {
      entry.swapCount++
      swapTotal++
    }
    sourceMap.set(e.source, entry)
  }
  const swapDenom = swapTotal || 1
  const bySource = Array.from(sourceMap.entries())
    .map(([source, data]) => ({
      source,
      tradeCount: data.count,
      volumeUsd: data.volume,
      winRate: (data.swapCount / swapDenom) * 100,
    }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)

  // Hourly volume
  const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, volumeUsd: 0, tradeCount: 0 }))
  for (const e of events) {
    byHour[e.hour].volumeUsd += e.volumeUsd
    byHour[e.hour].tradeCount++
  }

  // Top pairs
  const pairMap = new Map<string, { count: number; volume: number }>()
  for (const e of events) {
    if (!e.tokenIn || !e.tokenOut) continue
    const pair = `${e.tokenIn}/${e.tokenOut}`
    const entry = pairMap.get(pair) || { count: 0, volume: 0 }
    entry.count++
    entry.volume += e.volumeUsd
    pairMap.set(pair, entry)
  }
  const topPairs = Array.from(pairMap.entries())
    .map(([pair, data]) => ({ pair, tradeCount: data.count, volumeUsd: data.volume }))
    .sort((a, b) => b.volumeUsd - a.volumeUsd)
    .slice(0, 10)

  // Unique wallets
  const totalWallets = new Set(events.map(e => e.wallet)).size

  // Recent trades (latest 50) — API-MED-07: strip wallet addresses from public response
  const recentTrades = events.slice(0, 50).map(e => ({
    ...e,
    wallet: e.wallet ? `${e.wallet.slice(0, 6)}...${e.wallet.slice(-4)}` : '',
  }))

  // Daily volume (last 30 days)
  const dailyMap = new Map<string, { volume: number; count: number }>()
  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const e of events) {
    if (e.timestamp < cutoff30d) continue
    const date = new Date(e.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    const entry = dailyMap.get(date) || { volume: 0, count: 0 }
    entry.volume += e.volumeUsd
    entry.count++
    dailyMap.set(date, entry)
  }
  const dailyVolume = Array.from(dailyMap.entries())
    .map(([date, data]) => ({ date, volumeUsd: data.volume, tradeCount: data.count }))

  return {
    allTime,
    last24h,
    last7d,
    last30d,
    bySource,
    byHour,
    topPairs,
    totalWallets,
    recentTrades,
    dailyVolume,
  }
}
