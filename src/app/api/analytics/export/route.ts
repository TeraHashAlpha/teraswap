/**
 * [P100] GET /api/analytics/export — CSV download of a wallet's swap
 * history. Built for tax-software import (Koinly/CoinTracker/etc.):
 * ISO 8601 timestamps, human-readable amounts (raw wei → token
 * decimals), explicit headers, and proper CSV escaping (commas,
 * quotes, newlines).
 *
 * The expensive bit is reading every row for the wallet, so we
 * rate-limit at 5 req/hour per wallet — enough for occasional
 * downloads, not enough to abuse the endpoint.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { formatUnits } from 'viem'
import { getSupabase } from '@/lib/supabase'
import { isValidAddress } from '@/lib/validation'
import { checkRateLimit } from '@/lib/kv-rate-limiter'

export const dynamic = 'force-dynamic'

const RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 } // 5 req/hour

// Same map WalletHistory.tsx uses — kept locally so this route doesn't
// depend on a client component module.
const TOKEN_DECIMALS: Record<string, number> = {
  ETH: 18, WETH: 18, stETH: 18, wstETH: 18, cbETH: 18, rETH: 18,
  USDC: 6, USDT: 6,
  DAI: 18, FRAX: 18, LUSD: 18, sUSD: 18, crvUSD: 18, GHO: 18, PYUSD: 6,
  WBTC: 8, renBTC: 8, tBTC: 18,
  UNI: 18, LINK: 18, AAVE: 18, MKR: 18, SNX: 18, CRV: 18, LDO: 18,
  COMP: 18, BAL: 18, SUSHI: 18, '1INCH': 18, MATIC: 18, ARB: 18, OP: 18,
  SHIB: 18, PEPE: 18, APE: 18, DYDX: 18, ENS: 18, RPL: 18,
}

function getDecimals(symbol: string | null): number {
  if (!symbol) return 18
  return TOKEN_DECIMALS[symbol.toUpperCase()] ?? 18
}

/**
 * Convert a raw-wei amount string to a human-readable decimal string.
 * Returns the original input if it doesn't look like an integer wei
 * value (already-decimal entries from legacy rows pass through).
 */
function humanAmount(raw: string | null, symbol: string | null): string {
  if (!raw) return ''
  // Treat anything containing '.' as already human-readable.
  if (raw.includes('.')) return raw
  try {
    const decimals = getDecimals(symbol)
    return formatUnits(BigInt(raw), decimals)
  } catch {
    return raw
  }
}

/**
 * Escape one CSV cell. Two protections:
 *
 *   1. [13B-L-01] Prefix-sanitise cells starting with `=`, `+`, `-`,
 *      `@`, tab, or CR. These trigger formula evaluation in Excel and
 *      Google Sheets — a known CSV-injection vector for any data that
 *      can contain attacker-controlled strings (and token symbols can:
 *      scam ERC-20s with names like `=DROP` or `+APY` exist on-chain).
 *      The OWASP-recommended mitigation is to prepend a tab character,
 *      which the spreadsheet renders as the original value but doesn't
 *      treat as a formula.
 *   2. RFC-4180: wrap in double quotes if the value contains comma,
 *      quote, CR, or LF; double internal quotes.
 *
 * Order matters — prefix-sanitisation happens BEFORE RFC-4180 escaping
 * so the tab is included inside the quoted span when both apply.
 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  const safe = /^[=+\-@\t\r]/.test(str) ? `\t${str}` : str
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`
  }
  return safe
}

interface ExportRow {
  created_at: string
  source: string | null
  token_in_symbol: string | null
  token_out_symbol: string | null
  amount_in: string | null
  amount_out: string | null
  amount_in_usd: number | string | null
  gas_used: string | null
  gas_savings_usd: number | string | null
  is_gasless: boolean | null
  tx_hash: string | null
}

const CSV_HEADERS = [
  'Date',
  'Pair',
  'Source',
  'Amount In',
  'Token In',
  'Amount Out',
  'Token Out',
  'Volume USD',
  'Gas USD',
  'Gas Saved USD',
  'Gasless',
  'TX Hash',
]

/**
 * Convert a row set to a CSV string. Exported for the test suite.
 */
export function rowsToCsv(rows: ExportRow[]): string {
  const lines = [CSV_HEADERS.map(csvEscape).join(',')]
  for (const r of rows) {
    const pair =
      r.token_in_symbol && r.token_out_symbol
        ? `${r.token_in_symbol}/${r.token_out_symbol}`
        : ''
    lines.push(
      [
        new Date(r.created_at).toISOString(),
        pair,
        r.source ?? '',
        humanAmount(r.amount_in, r.token_in_symbol),
        r.token_in_symbol ?? '',
        humanAmount(r.amount_out, r.token_out_symbol),
        r.token_out_symbol ?? '',
        r.amount_in_usd ?? '',
        // The `swaps` table stores gas_used (raw units) but no derived
        // USD — leave the column empty when we don't have a value. The
        // dedicated gas_savings_usd column (from P96) IS USD-denominated.
        '',
        r.gas_savings_usd ?? 0,
        r.is_gasless ? 'true' : 'false',
        r.tx_hash ?? '',
      ]
        .map(csvEscape)
        .join(','),
    )
  }
  return lines.join('\r\n') + '\r\n'
}

function downloadFilename(wallet: string): string {
  const short = `${wallet.slice(0, 6)}${wallet.slice(-4)}`.toLowerCase()
  const date = new Date().toISOString().slice(0, 10)
  return `teraswap-history-${short}-${date}.csv`
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const wallet = req.nextUrl.searchParams.get('wallet')
  const format = req.nextUrl.searchParams.get('format')

  if (!wallet) {
    return NextResponse.json(
      { error: 'Missing required query param: wallet' },
      { status: 400 },
    )
  }
  if (!isValidAddress(wallet)) {
    return NextResponse.json(
      { error: 'wallet must be a valid 0x-prefixed 20-byte address.' },
      { status: 400 },
    )
  }
  if (format && format !== 'csv') {
    return NextResponse.json(
      { error: 'format must be "csv" (the only supported format).' },
      { status: 400 },
    )
  }

  const walletLc = wallet.toLowerCase()
  const rate = await checkRateLimit(
    `analytics-export:${walletLc}`,
    RATE_LIMIT.limit,
    RATE_LIMIT.windowMs,
  )
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Export rate limit exceeded. Try again in an hour.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(
            Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000)),
          ),
        },
      },
    )
  }

  const supabase = getSupabase()
  if (!supabase) {
    // Same empty CSV the empty-wallet branch returns — keeps the contract
    // predictable rather than surfacing infra-level errors to integrators.
    return new NextResponse(rowsToCsv([]), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${downloadFilename(walletLc)}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  const { data, error } = await supabase
    .from('swaps')
    .select(
      'created_at, source, token_in_symbol, token_out_symbol, amount_in, amount_out, amount_in_usd, gas_used, gas_savings_usd, is_gasless, tx_hash, status',
    )
    .eq('wallet', walletLc)
    .or('status.eq.confirmed,and(status.eq.pending,tx_hash.not.is.null)')
    .order('created_at', { ascending: false })
    .limit(10_000)

  if (error) {
    console.error('[analytics/export] supabase error:', error.message)
    return NextResponse.json(
      { error: 'Could not export history. Please retry.' },
      { status: 502 },
    )
  }

  const csv = rowsToCsv((data ?? []) as ExportRow[])
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${downloadFilename(walletLc)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
