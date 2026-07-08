import { NextResponse, type NextRequest } from 'next/server'
import { getSupabase } from '@/lib/supabase'
import { isValidAddress } from '@/lib/validation'
import {
  verifyOrdersReadAccess,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
} from '@/lib/order-engine/read-auth'
import { checkRateLimit } from '@/lib/kv-rate-limiter'

// [CHORE-API-HARDENING-2 / P3d] Per-wallet rate limit — this route had NONE,
// unlike its /api/orders and /api/analytics/export siblings. Generous enough for
// normal polling (a wallet history view re-fetches occasionally), tight enough to
// bound scripted enumeration of arbitrary wallets.
const HISTORY_RATE_LIMIT = { limit: 30, windowMs: 60_000 } // 30 req/min per wallet

// [CHORE-API-HARDENING-2 / P3d] Cap how deep a caller can page. An OFFSET scan is
// O(offset) in Postgres regardless of index, so an unbounded offset is a DB-load
// amplifier; 2000 is far beyond any real pagination UI ever reaches (20 pages at
// the 100-row max limit).
const MAX_OFFSET = 2_000

/**
 * GET /api/history?wallet=0x...&limit=50
 *
 * Wallet activity feed. Historically this read ONLY the `swaps` table (instant
 * swaps logged client-side via /api/log-swap). DCA / limit / stop-loss fills are
 * keeper-executed → they never flow through /api/log-swap and were structurally
 * invisible here.
 *
 * [CHORE-DCA-VISIBILITY-AND-STATS #2] We now merge the wallet's confirmed
 * conditional-order fills (`order_executions ⋈ orders`) into the same feed —
 * reusing the exact swaps-first `tx_hash` dedup already proven in /api/analytics.
 *
 * W6 read-auth: instant swaps stay public-by-address (unchanged — on-chain data,
 * matches the terminal-order boundary in read-auth.ts). The DCA fills, however,
 * are the WALLET'S OWN activity and an ACTIVE DCA's fills would leak its running
 * strategy — so fills are surfaced ONLY when the caller presents the same
 * per-session read signature as /api/orders. No/invalid token ⇒ swaps only
 * (today's behaviour, never broken). A caller can never see another wallet's
 * fills: the query is wallet-scoped via the join AND gated by the signature.
 */
export async function GET(req: NextRequest) {
  const supabase = getSupabase()
  if (!supabase) {
    return NextResponse.json({ swaps: [], total: 0 })
  }

  const { searchParams } = req.nextUrl
  const wallet = searchParams.get('wallet')?.toLowerCase()
  const limit = Math.min(Number(searchParams.get('limit') ?? '50'), 100)
  // [CHORE-API-HARDENING-2 / P3d] Clamp offset — an unbounded OFFSET is an
  // O(offset) DB-load amplifier regardless of index.
  const offset = Math.min(Math.max(Number(searchParams.get('offset') ?? '0'), 0), MAX_OFFSET)

  if (!wallet || !isValidAddress(`0x${wallet.replace('0x', '')}`)) {
    return NextResponse.json(
      { error: 'Missing required param: wallet' },
      { status: 400 },
    )
  }

  // [CHORE-API-HARDENING-2 / P3d] Per-wallet rate limit — this endpoint had none,
  // letting a caller enumerate arbitrary wallets and page unbounded. Fail-open on
  // a KV error/timeout (read-only price/history info, same posture as the
  // sibling read routes) — checkRateLimit itself fails open on KV errors.
  const rateCheck = await checkRateLimit(`history:${wallet}`, HISTORY_RATE_LIMIT.limit, HISTORY_RATE_LIMIT.windowMs)
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Try again in a minute.' },
      {
        status: 429,
        headers: {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rateCheck.resetAt),
        },
      },
    )
  }

  try {
    // [CHORE-API-HARDENING-2 / P3d] 'estimated' (exact for low counts, planned/
    // statistics-based for high counts) instead of 'exact' — avoids a full
    // COUNT(*) table scan on every request while staying accurate for the common
    // case (a wallet with a modest swap history).
    const { data: swapRows, error, count } = await supabase
      .from('swaps')
      .select('*', { count: 'estimated' })
      .eq('wallet', wallet)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error('[history] Supabase error:', error.message)
      return NextResponse.json({ swaps: [], total: 0 })
    }

    const swapItems = (swapRows ?? []).map(mapSwapRow)

    // [CHORE-DCA-VISIBILITY-AND-STATS #2] W6 read-auth gate for the DCA fills.
    // Same trust anchor as /api/orders (recoverTypedDataAddress over the signed
    // OrdersReadAccess message). Fail-soft: a missing/invalid token is simply a
    // swaps-only feed, never an error — instant swap history is never regressed.
    let fillItems: HistoryItem[] = []
    let fillsIncluded = false
    const auth = await verifyOrdersReadAccess({
      wallet,
      issuedAt: req.headers.get(ORDERS_READ_HEADER_ISSUED),
      signature: req.headers.get(ORDERS_READ_HEADER_SIGNATURE),
    })
    if (auth.ok) {
      const fills = await fetchConfirmedFills(supabase, wallet, MAX_FILLS)
      fillItems = fills.map(mapFillRow).filter((f): f is HistoryItem => f !== null)
      fillsIncluded = true
    }

    const merged = mergeHistory(swapItems, fillItems, limit)

    return NextResponse.json({
      swaps: merged,
      // Swaps count is authoritative for the swaps table; add the surfaced fills
      // (a fill sharing a swap's tx_hash is deduped out of the list but this
      // total is a display hint, not a paginator, so a rare +1 is harmless).
      total: (count ?? 0) + fillItems.length,
      fillsIncluded,
    })
  } catch (err) {
    console.error('[history] Error:', err)
    return NextResponse.json({ swaps: [], total: 0 })
  }
}

// Cap the fills fetch so a wallet with a huge conditional-order history can't
// drive an unbounded query; the merged feed is sliced to `limit` anyway.
const MAX_FILLS = 200

/** Discriminated item in the merged history feed. */
export interface HistoryItem {
  kind: 'swap' | 'dca_fill'
  id: string
  tx_hash: string | null
  source: string
  token_in_symbol: string
  token_out_symbol: string
  amount_in: string
  amount_out: string
  amount_in_usd: number | null
  status: string
  created_at: string
  chain_id: number
  // dca_fill only — reference to the parent conditional-order position:
  order_id?: string | null
  order_type?: string
  execution_number?: number | null
  dca_total?: number | null
  dca_executed?: number | null
}

/** A `swaps` row, tagged with the `kind` discriminator. All original columns are
 *  preserved so WalletHistory keeps rendering instant swaps byte-identically. */
export function mapSwapRow(row: Record<string, unknown>): HistoryItem {
  return { ...(row as object), kind: 'swap' } as HistoryItem
}

/**
 * An `order_executions` row (with its `orders` parent embedded via the inner
 * join) → a `dca_fill` history item. Returns null when the parent didn't embed
 * (can't attribute the fill). The amounts are the ACTUAL per-fill figures the
 * keeper decoded from the on-chain OrderExecuted event (amount_out is the ACTUAL
 * received, not the swap table's EXPECTED output).
 */
export function mapFillRow(row: Record<string, unknown>): HistoryItem | null {
  const orderRaw = (row as { orders?: unknown }).orders
  const order = (Array.isArray(orderRaw) ? orderRaw[0] : orderRaw) as
    | Record<string, unknown>
    | null
    | undefined
  if (!order) return null

  return {
    kind: 'dca_fill',
    id: (row.id as string) || (row.tx_hash as string) || '',
    tx_hash: (row.tx_hash as string) ?? null,
    source: (order.order_type as string) || 'dca',
    token_in_symbol: (order.token_in_symbol as string) || '',
    token_out_symbol: (order.token_out_symbol as string) || '',
    amount_in: String(row.amount_in ?? '0'),
    amount_out: String(row.amount_out ?? '0'),
    amount_in_usd: null,
    status: (row.status as string) || 'confirmed',
    created_at: (row.created_at as string) || '',
    chain_id: Number(order.chain_id) || 1,
    order_id: (row.order_id as string) ?? null,
    order_type: (order.order_type as string) || 'dca',
    execution_number:
      row.execution_number != null ? Number(row.execution_number) : null,
    dca_total: order.dca_total != null ? Number(order.dca_total) : null,
    dca_executed: order.dca_executed != null ? Number(order.dca_executed) : null,
  }
}

/**
 * Merge instant swaps with conditional-order fills into one newest-first,
 * de-duplicated feed. Swaps are listed FIRST so a tx present in both tables
 * resolves to the swap row (identical rule to /api/analytics computeDashboard).
 */
export function mergeHistory(
  swapItems: HistoryItem[],
  fillItems: HistoryItem[],
  limit?: number,
): HistoryItem[] {
  const seen = new Set<string>()
  const out: HistoryItem[] = []
  for (const item of [...swapItems, ...fillItems]) {
    const tx = item.tx_hash
    if (tx) {
      if (seen.has(tx)) continue
      seen.add(tx)
    }
    out.push(item)
  }
  out.sort((a, b) => tsMs(b.created_at) - tsMs(a.created_at))
  return typeof limit === 'number' ? out.slice(0, limit) : out
}

function tsMs(v: string): number {
  const t = v ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * Fetch the wallet's CONFIRMED conditional-order fills with the parent order
 * embedded. `orders!inner(...)` + `.eq('orders.wallet', wallet)` scopes the
 * top-level rows to the wallet's own orders (inner join drops non-matching).
 * Service-role client ⇒ no RLS/JWT concern. Fail-soft: any error returns [] so
 * a fills-side problem never regresses the swaps feed.
 */
async function fetchConfirmedFills(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  wallet: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  try {
    const { data, error } = await supabase
      .from('order_executions')
      .select(
        'id,created_at,tx_hash,amount_in,amount_out,status,execution_number,order_id,' +
          'orders!inner(wallet,order_type,token_in_symbol,token_out_symbol,' +
          'token_in_decimals,token_out_decimals,chain_id,dca_total,dca_executed)',
      )
      .eq('orders.wallet', wallet)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('[history] order_executions query failed:', error.message)
      return []
    }
    return (data as unknown as Record<string, unknown>[]) ?? []
  } catch (err) {
    console.error('[history] order_executions query error:', err)
    return []
  }
}
