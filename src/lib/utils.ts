/**
 * Shared low-level utilities.
 *
 * Keep this module free of project-specific types — it must be importable
 * from anywhere in src/ without creating a circular dependency. Anything
 * stateful (KV, network, React) belongs elsewhere.
 */

// ── safeBigInt ─────────────────────────────────────────────────
//
// [10-L-01] Defensive replacement for bare `BigInt(value)` calls.
//
// `BigInt(undefined)` and `BigInt('NaN')` throw SyntaxError. With a public
// API surface, malformed values coming back from third-party consumers
// or stale cached quotes used to crash whatever component tried to
// convert them. `safeBigInt` returns `null` for any value it can't
// faithfully parse as an integer, logs a single warning for telemetry,
// and never throws.
//
// Accepted inputs:
//   - bigint (returned as-is)
//   - number that satisfies Number.isInteger and Number.isFinite
//   - string matching /^-?\d+$/ (decimal integer; hex / scientific /
//     whitespace are rejected on purpose — token amounts are always
//     decimal wei strings in this codebase)
//
// Everything else (undefined, null, '', 'NaN', '0x123', '1.5', objects,
// booleans, ...) → null.

/** Set to true in tests to silence the warning channel. */
let _safeBigIntWarn = true

export function _setSafeBigIntWarn(on: boolean): void {
  _safeBigIntWarn = on
}

function warn(reason: string, value: unknown): void {
  if (!_safeBigIntWarn) return
  // Tag the message so log search can find every rejection in one query.
  console.warn(
    `[safeBigInt] rejected (${reason}):`,
    // Quote strings so empty / whitespace-only values are visible.
    typeof value === 'string' ? JSON.stringify(value) : value,
  )
}

const DECIMAL_INT_RE = /^-?\d+$/

export function safeBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'bigint') return value

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      warn('non-integer-number', value)
      return null
    }
    return BigInt(value)
  }

  if (typeof value === 'string') {
    if (value.length === 0) {
      // Don't warn on empty string — common "not yet loaded" sentinel.
      return null
    }
    if (!DECIMAL_INT_RE.test(value)) {
      warn('non-numeric-string', value)
      return null
    }
    try {
      return BigInt(value)
    } catch {
      // Defensive belt — regex should prevent ever reaching here, but
      // catch covers any future runtime edge case (e.g. a bigint that
      // somehow round-trips through a string outside our regex).
      warn('bigint-parse-failed', value)
      return null
    }
  }

  warn(`unsupported-type-${typeof value}`, value)
  return null
}
