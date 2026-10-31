/**
 * [ADR-025 / B7 C3] The History tab's pure decisions. v1 keeps them module-private in WalletHistory.tsx (the record shape, `shortenHash`,
 * `timeAgo`, the symbol → decimals table, `formatHumanAmount`, `sourceLabel`, the status badge) — nothing to import, so this module
 * restates the SAME expressions; `history.test.tsx` renders v1 and v2 on one mocked `/api/history` answer and compares what each prints.
 * Amounts go through format.ts (`fmtToken`, the bigint path with the decimals v1 infers). Display only.
 */
import { fmtToken } from '@/lib/format'

/** v1 `SwapRecord`: instant swaps merged with the wallet's keeper-executed DCA fills (`kind`). */
export interface SwapRecord {
  kind?: 'swap' | 'dca_fill'
  id: string
  wallet?: string
  tx_hash: string | null
  source: string
  token_in_symbol: string
  token_out_symbol: string
  amount_in: string
  amount_out: string
  amount_in_usd: number | null
  amount_out_usd?: number | null
  status: string
  fee_collected?: boolean
  fee_amount?: string | null
  slippage?: number
  mev_protected?: boolean
  created_at: string
  chain_id: number
  order_id?: string | null
  order_type?: string
  execution_number?: number | null
  dca_total?: number | null
  dca_executed?: number | null
}

/** v1 `shortenHash`. */
export function shortenHash(hash: string): string {
  return `${hash.slice(0, 8)}...${hash.slice(-6)}`
}

/** v1 `timeAgo` (it has a months step that format.ts's `fmtRelTime` does not — v1's words win). */
export function timeAgo(dateStr: string, now: number): string {
  const diff = now - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

/** v1 `TOKEN_DECIMALS` — the records carry no decimals; v1 infers them from the symbol (default 18). */
const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18, WETH: 18, stETH: 18, wstETH: 18, cbETH: 18, rETH: 18,
  USDC: 6, USDT: 6,
  DAI: 18, FRAX: 18, LUSD: 18, sUSD: 18, crvUSD: 18, GHO: 18, PYUSD: 6,
  WBTC: 8, renBTC: 8, tBTC: 18,
  UNI: 18, LINK: 18, AAVE: 18, MKR: 18, SNX: 18, CRV: 18, LDO: 18,
  COMP: 18, BAL: 18, SUSHI: 18, '1INCH': 18, MATIC: 18, ARB: 18, OP: 18,
  SHIB: 18, PEPE: 18, APE: 18, DYDX: 18, ENS: 18, RPL: 18,
}

/** v1 `getDecimals` (the upper-cased lookup, as v1 — so mixed-case keys like `stETH` fall back to 18 exactly as there). */
export function historyDecimals(symbol: string): number {
  return TOKEN_DECIMALS[symbol?.toUpperCase()] ?? 18
}

/**
 * v1 `formatHumanAmount`: Supabase stores raw units; a value that already looks human (a dot, under 1e6) is taken as is; otherwise the
 * raw integer part is scaled by the inferred decimals. Rendered by `fmtToken` (bigint path for raw values), v1's raw text on failure.
 */
export function historyAmount(rawVal: string, symbol: string): string {
  try {
    const decimals = historyDecimals(symbol)
    const n = Number(rawVal)
    if (isNaN(n)) return rawVal
    const looksHumanReadable = rawVal.includes('.') && n < 1e6
    return looksHumanReadable ? fmtToken(n) : fmtToken(BigInt(rawVal.split('.')[0]), decimals)
  } catch {
    return rawVal
  }
}

/** v1 `sourceLabel`, verbatim: a few known display names, else the raw source (v1 prints `velora` — the frame's title case is not v1). */
export function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    '1inch': '1inch',
    '0x': '0x',
    paraswap: 'ParaSwap',
    kyberswap: 'KyberSwap',
    odos: 'Odos',
    openocean: 'OpenOcean',
    uniswap: 'Uniswap',
  }
  return map[s?.toLowerCase()] || s || 'Unknown'
}

/** v1 `statusBadge`: confirmed (confirmed / success), failed (failed / reverted), else pending — v1's lower-case words. */
export function statusKind(status: string): { text: 'confirmed' | 'failed' | 'pending'; tone: 'green' | 'red' | 'muted' } {
  if (status === 'confirmed' || status === 'success') return { text: 'confirmed', tone: 'green' }
  if (status === 'failed' || status === 'reverted') return { text: 'failed', tone: 'red' }
  return { text: 'pending', tone: 'muted' }
}

/** v1's sub-line for a DCA fill: `Fill #n of m` (or `DCA fill`). */
export function fillLabel(r: SwapRecord): string {
  return r.execution_number != null && r.dca_total != null ? `Fill #${r.execution_number} of ${r.dca_total}` : 'DCA fill'
}
