import { getAddress } from 'viem'

/**
 * Format a number string with spaces as thousand separators.
 * Works for both integers and decimals.
 *
 * Examples:
 *   "111111"     → "111 111"
 *   "1234567.89" → "1 234 567.89"
 *   "0.001234"   → "0.001234"
 *   ""           → ""
 */
export function formatWithSeparator(value: string): string {
  if (!value) return value
  const [intPart, decPart] = value.split('.')
  // Add spaces every 3 digits from the right in the integer part
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return decPart !== undefined ? `${formatted}.${decPart}` : formatted
}

/**
 * Strip thousand separators (spaces) so the raw number can be parsed.
 * "111 111.5" → "111111.5"
 */
export function stripSeparator(value: string): string {
  return value.replace(/\s/g, '')
}

/**
 * Format a numeric display value with thousand separators.
 * Use this for output amounts, balances, etc.
 *
 * @param value  - number or string to format
 * @param maxDecimals - max decimal places to show (default: 4)
 *
 * @deprecated Superseded by `fmtToken` (design README §3). Kept — not deleted —
 * for call sites outside the numeric-formatter migration; do not add new uses.
 */
export function formatDisplay(value: number | string, maxDecimals: number = 4): string {
  const num = typeof value === 'number' ? value : parseFloat(value)
  if (isNaN(num)) return '0'
  // For very small numbers, show more decimals
  if (num > 0 && num < 0.0001) {
    return formatWithSeparator(num.toFixed(8))
  }
  return formatWithSeparator(num.toFixed(maxDecimals))
}

// ─────────────────────────────────────────────────────────────────────────────
// Single display formatter — design README §3 ("Number-format spec", binding
// app-wide). DISPLAY ONLY: nothing that is signed, sent, compared or stored may
// pass through these functions (wei/bigint amounts for txs, minOut, allowances
// and API payloads stay untouched). All output is locale-independent: decimal
// POINT, thin space (U+2009) as thousands separator, never Intl / toLocaleString.
// ─────────────────────────────────────────────────────────────────────────────

const THIN_SPACE = '\u2009'
const MINUS = '\u2212'
const DASH = '\u2014'

/**
 * Input accepted by the numeric formatters. null/undefined/NaN render as "—".
 *
 * bigint rule: a bigint is an exact INTEGER in the unit the formatter displays
 * (a block number, a count) and is only ever scaled by 10^decimals where the
 * formatter's signature takes `decimals` (`fmtToken`). `fmtInt`, `fmtFixed`,
 * `fmtUsd`, `fmtPct` and `fmtGas` take no `decimals`, so their bigints are not scaled.
 */
export type FmtInput = number | string | bigint | null | undefined

/** Shortest decimal string for a bigint scaled by 10^decimals (exact, no floats). */
function bigintToDecimalString(value: bigint, decimals: number): string {
  const neg = value < 0n
  const digits = (neg ? -value : value).toString().padStart(decimals + 1, '0')
  const intPart = decimals > 0 ? digits.slice(0, digits.length - decimals) : digits
  const fracPart = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : ''
  return `${neg ? '-' : ''}${intPart}${fracPart ? `.${fracPart}` : ''}`
}

/**
 * Normalise any accepted input to a finite number, or null when not displayable.
 * `decimals` only scales a bigint and defaults to 0 (plain integer) — callers that
 * mean a wei-style amount (`fmtToken`) must say so.
 */
function toFiniteNumber(value: FmtInput, decimals = 0): number | null {
  if (value === null || value === undefined) return null
  let n: number
  if (typeof value === 'bigint') n = Number(bigintToDecimalString(value, decimals))
  else if (typeof value === 'string') {
    const t = value.replace(/[\s\u2009,]/g, '')
    if (t === '') return null
    n = Number(t)
  } else n = value
  return Number.isFinite(n) ? n : null
}

/** Group the integer part of a plain (non-exponent) decimal string with thin spaces. */
function groupThin(plain: string): string {
  const [int, frac] = plain.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE)
  return frac !== undefined ? `${grouped}.${frac}` : grouped
}

/** toFixed that never falls back to exponent notation (|x| >= 1e21). */
function fixedPlain(abs: number, dp: number): string {
  if (abs < 1e21) return abs.toFixed(dp)
  const int = BigInt(Math.round(abs)).toString()
  return dp > 0 ? `${int}.${'0'.repeat(dp)}` : int
}

function trimZeros(plain: string): string {
  return plain.includes('.') ? plain.replace(/\.?0+$/, '') : plain
}

function withSign(body: string, neg: boolean, plus: boolean): string {
  if (neg) return `${MINUS}${body}`
  return plus ? `+${body}` : body
}

export interface FmtTokenOpts {
  /** Prefix "+" on positive values (P&L / deltas). */
  sign?: boolean
  /**
   * Exact raw value (signing review / tooltip only — §3): every decimal kept,
   * trailing zeros trimmed, thin-space grouping, no rounding and no floor.
   * Strings and bigints are not routed through Number.
   */
  exact?: boolean
}

/**
 * Token amount (§3): ≥ 1 → 4 dp (kept, `1 713.1810`); < 1 → 4 significant digits,
 * max 8 dp, trailing zeros trimmed; below 1e-8 → `<0.00000001`; 0 → `0`.
 * `decimals` only scales a bigint (wei → units, default 18); numbers/strings are
 * already human units.
 */
export function fmtToken(value: FmtInput, decimals = 18, opts: FmtTokenOpts = {}): string {
  if (opts.exact) {
    let plain: string | null = null
    if (typeof value === 'bigint') plain = bigintToDecimalString(value, decimals)
    else if (typeof value === 'string') {
      const t = value.replace(/[\s\u2009,]/g, '')
      if (/^-?\d+(\.\d+)?$/.test(t)) plain = trimZeros(t)
    }
    if (plain !== null) {
      const neg = plain.startsWith('-')
      return withSign(groupThin(neg ? plain.slice(1) : plain), neg, !!opts.sign && plain !== '0')
    }
  }
  const n = toFiniteNumber(value, decimals)
  if (n === null) return DASH
  if (n === 0) return '0'
  const neg = n < 0
  const abs = Math.abs(n)
  if (opts.exact) return withSign(groupThin(trimZeros(fixedPlain(abs, 18))), neg, !!opts.sign)
  if (abs < 1e-8) return '<0.00000001'
  // 4 significant digits, via toExponential so a round-up to 1.000e+0 lands in the ≥ 1 branch.
  const exp = Number(abs.toExponential(3).split('e')[1])
  let body: string
  if (abs >= 1 || exp >= 0) {
    body = groupThin(fixedPlain(abs, 4))
  } else {
    body = trimZeros(fixedPlain(abs, Math.min(8, 3 - exp)))
    if (body === '0') return '<0.00000001'
  }
  return withSign(body, neg, !!opts.sign)
}

export interface FmtUsdOpts {
  /** Prefix "+" on positive values (P&L). */
  sign?: boolean
  /** Dashboard aggregates: ≥ $1M → `$1.23M`, ≥ $1k → `$12.3K`. */
  compact?: boolean
}

/** USD (§3): `$` + 2 dp, thin-space grouping, below $0.01 → `<$0.01`, negatives with U+2212. */
export function fmtUsd(value: FmtInput, opts: FmtUsdOpts = {}): string {
  const n = toFiniteNumber(value)
  if (n === null) return DASH
  const neg = n < 0
  const abs = Math.abs(n)
  if (abs > 0 && abs < 0.01) return '<$0.01'
  let body: string
  if (opts.compact && abs >= 1_000_000) body = `$${fixedPlain(abs / 1_000_000, 2)}M`
  else if (opts.compact && abs >= 1_000) body = `$${fixedPlain(abs / 1_000, 1)}K`
  else body = `$${groupThin(fixedPlain(abs, 2))}`
  return withSign(body, neg && body !== '$0.00', !!opts.sign && abs > 0)
}

/**
 * Percentage (§3): value is already in percent units (`0.12` → `0.12%`); up to `dp`
 * decimals (default 2), trailing zeros trimmed, no space before `%`.
 */
export function fmtPct(value: FmtInput, dp = 2, opts: { sign?: boolean } = {}): string {
  const n = toFiniteNumber(value)
  if (n === null) return DASH
  const body = trimZeros(fixedPlain(Math.abs(n), dp))
  const isZero = body === '0'
  return `${withSign(groupThin(body), n < 0 && !isZero, !!opts.sign && n > 0 && !isZero)}%`
}

/** Plain integer / count (block numbers, trade counts): thin-space grouping, rounded. */
export function fmtInt(value: FmtInput): string {
  const n = toFiniteNumber(value)
  if (n === null) return DASH
  const body = groupThin(fixedPlain(Math.abs(Math.round(n)), 0))
  return n < 0 && /[1-9]/.test(body) ? `${MINUS}${body}` : body
}

/** Fixed-dp decimal for non-token scalars (scores, durations); thin-space grouping. */
export function fmtFixed(value: FmtInput, dp: number): string {
  const n = toFiniteNumber(value)
  if (n === null) return DASH
  const body = groupThin(fixedPlain(Math.abs(n), dp))
  return n < 0 && /[1-9]/.test(body) ? `${MINUS}${body}` : body
}

/**
 * Gas in ETH (§3): 2 significant digits, never `0.0000` for a non-zero value
 * (`0.0000012` → `0.0000012`, `0.0031` → `0.0031`). Unit and USD: see `fmtGasCost`.
 */
export function fmtGas(eth: FmtInput): string {
  const n = toFiniteNumber(eth)
  if (n === null) return DASH
  if (n === 0) return '0'
  const abs = Math.abs(n)
  const exp = Number(abs.toExponential(1).split('e')[1])
  const body = trimZeros(fixedPlain(abs, Math.max(0, 1 - exp)))
  return withSign(groupThin(body), n < 0, false)
}

/** Gas line (§3): `~0.0000081 ETH ($0.03)`; USD part omitted when not provided. */
export function fmtGasCost(eth: FmtInput, usd?: FmtInput, symbol = 'ETH'): string {
  const base = `~${fmtGas(eth)} ${symbol}`
  return usd === undefined || usd === null ? base : `${base} (${fmtUsd(usd)})`
}

/**
 * Address (§3): lowercase `0x` prefix, checksummed body; `short` → `0x1234…abcd`.
 * Anything that is not a 40-hex address (ENS names, empty) is returned unchanged.
 */
export function fmtAddress(addr: string | null | undefined, opts: { short?: boolean } = {}): string {
  if (!addr) return DASH
  let out = addr
  if (/^0x[0-9a-f]{40}$/i.test(addr)) {
    try {
      out = getAddress(addr)
    } catch {
      out = `0x${addr.slice(2)}`
    }
    out = `0x${out.slice(2)}`
  }
  return opts.short ? `${out.slice(0, 6)}\u2026${out.slice(-4)}` : out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number) => String(n).padStart(2, '0')

/** Date (§3): `12 Oct 2026, 14:05` (24 h). Local time unless `utc` is set. Invalid → "—". */
export function fmtDate(input: Date | number | string | null | undefined, opts: { utc?: boolean } = {}): string {
  if (input === null || input === undefined || input === '') return DASH
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return DASH
  const u = !!opts.utc
  const day = u ? d.getUTCDate() : d.getDate()
  const mon = MONTHS[u ? d.getUTCMonth() : d.getMonth()]
  const yr = u ? d.getUTCFullYear() : d.getFullYear()
  const hh = u ? d.getUTCHours() : d.getHours()
  const mm = u ? d.getUTCMinutes() : d.getMinutes()
  return `${day} ${mon} ${yr}, ${pad2(hh)}:${pad2(mm)}`
}

/** Relative time (§3): `2m ago`, `3h ago`, `5d ago`; under a minute (or clock skew) → `just now`. */
export function fmtRelTime(input: Date | number | string | null | undefined, now: number = Date.now()): string {
  if (input === null || input === undefined || input === '') return DASH
  const t = input instanceof Date ? input.getTime() : new Date(input).getTime()
  if (Number.isNaN(t)) return DASH
  const s = Math.floor((now - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}
