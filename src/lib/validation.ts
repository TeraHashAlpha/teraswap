/**
 * Shared validation utilities for API routes and client-side code.
 * Centralizes address/amount/txHash validation to avoid inconsistencies.
 */

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/

/** Check if a string is a valid Ethereum address (0x + 40 hex chars) */
export function isValidAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && ADDRESS_RE.test(addr)
}

/** Check if a string is a valid transaction hash (0x + 64 hex chars) */
export function isValidTxHash(hash: unknown): hash is string {
  return typeof hash === 'string' && TX_HASH_RE.test(hash)
}

/** Check if a value is a positive numeric string (for token amounts) */
export function isValidAmount(amount: unknown): amount is string {
  if (typeof amount !== 'string') return false
  const num = Number(amount)
  return !isNaN(num) && num > 0 && isFinite(num)
}

/** Validate and cap a string to a max length (for DB fields) */
export function cap(val: unknown, max = 500): string {
  if (typeof val !== 'string') return ''
  return val.slice(0, max)
}

/** Validate origin header against allowed domains */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  return (
    origin === 'https://teraswap.app' ||
    origin === 'https://www.teraswap.app' ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:')
  )
}
