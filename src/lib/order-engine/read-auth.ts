/**
 * [AUDIT-W6 / W6-M-01] Orders read-auth — per-session proof-of-wallet-ownership
 * for reading ACTIVE/PENDING conditional-order strategy.
 *
 * Why: `GET /api/orders?wallet=` used to be public-by-address via the
 * service-role client, exposing a wallet's PENDING order strategy
 * (targetPrice / amounts / type) before execution — a front-running /
 * strategy-copy vector (T-SAF W6-M-01). Order WRITES were already
 * signature-gated; this closes the read side with the same trust anchor
 * (recoverTypedDataAddress), while terminal-status reads stay public
 * (owner-decided boundary — on-chain history is public anyway).
 *
 * How: the client signs ONE lightweight SIWE-style EIP-712 message per
 * session (sign once, not per read). The signature itself is the read token —
 * stateless: the server recovers the signer per request and requires
 * recovered === wallet, issuedAt within TTL, no future skew. No server secret,
 * no KV state, nothing to rotate or leak. The token only grants READ of the
 * signer's own orders; it can never move funds.
 *
 * Isomorphic: build/verify run on both sides; the session cache + sign-once
 * orchestration are client-only (sessionStorage + module state).
 */
import { recoverTypedDataAddress } from 'viem'

export const ORDERS_READ_TTL_MS = 24 * 60 * 60 * 1000 // sign once per day at most
export const ORDERS_READ_MAX_SKEW_MS = 5 * 60 * 1000 // tolerated client-clock drift
export const ORDERS_READ_HEADER_ISSUED = 'x-orders-read-issued'
export const ORDERS_READ_HEADER_SIGNATURE = 'x-orders-read-signature'

/** Statuses whose rows stay publicly readable by address (terminal — the
 *  strategy already executed/died; on-chain data is public). Anything NOT in
 *  this set (active, executing, partially_filled, future additions) is
 *  protected: default-deny. */
export const PUBLIC_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'executed',
  'cancelled',
  'expired',
  'failed',
])

const READ_DOMAIN = { name: 'TeraSwap Orders', version: '1' } as const
const READ_TYPES = {
  OrdersReadAccess: [
    { name: 'wallet', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const
export const ORDERS_READ_PURPOSE =
  'Read my TeraSwap conditional orders. This signature cannot move funds.'

/** The EIP-712 payload the wallet signs — wallet is lowercased on BOTH the
 *  build and verify sides so query-param casing can never break recovery. */
export function buildOrdersReadTypedData(wallet: string, issuedAtSec: number) {
  return {
    domain: READ_DOMAIN,
    types: READ_TYPES,
    primaryType: 'OrdersReadAccess' as const,
    message: {
      wallet: wallet.toLowerCase() as `0x${string}`,
      purpose: ORDERS_READ_PURPOSE,
      issuedAt: BigInt(issuedAtSec),
    },
  }
}

/** Thrown by the client fetch layer on a 401 READ_AUTH_REQUIRED so the hook
 *  can sign once and retry (see useOrderEngine). */
export class ReadAuthRequiredError extends Error {
  constructor() {
    super('Orders read requires a session signature')
    this.name = 'ReadAuthRequiredError'
  }
}

interface VerifyParams {
  wallet: string
  issuedAt: string | number | null
  signature: string | null
  /** Injectable clock for tests. */
  nowMs?: number
}

/**
 * Server-side gate: does `signature` prove ownership of `wallet` for a fresh
 * session? Never throws — malformed input is just a refusal.
 */
export async function verifyOrdersReadAccess(
  params: VerifyParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { wallet, issuedAt, signature } = params
  const nowMs = params.nowMs ?? Date.now()

  if (!signature || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return { ok: false, error: 'Missing or malformed read signature' }
  }
  const issuedAtSec =
    typeof issuedAt === 'number' ? issuedAt : issuedAt ? Number.parseInt(issuedAt, 10) : NaN
  if (!Number.isInteger(issuedAtSec) || issuedAtSec <= 0) {
    return { ok: false, error: 'Missing or malformed issuedAt' }
  }

  const ageMs = nowMs - issuedAtSec * 1000
  if (ageMs > ORDERS_READ_TTL_MS) return { ok: false, error: 'Read signature expired — sign again' }
  if (ageMs < -ORDERS_READ_MAX_SKEW_MS) return { ok: false, error: 'issuedAt is in the future' }

  try {
    const typed = buildOrdersReadTypedData(wallet, issuedAtSec)
    const recovered = await recoverTypedDataAddress({
      ...typed,
      signature: signature as `0x${string}`,
    })
    if (recovered.toLowerCase() !== wallet.toLowerCase()) {
      return { ok: false, error: 'Signature does not match the requested wallet' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: 'Read signature verification failed' }
  }
}

// ── Client-side session cache + sign-once orchestration ─────────────────────

export interface OrdersReadAuth {
  issuedAt: number
  signature: `0x${string}`
}

const cacheKey = (wallet: string) => `teraswap:orders-read:${wallet.toLowerCase()}`
/** Re-sign a little before the server-side TTL so a cached-but-expiring
 *  signature never races the gate. */
const CACHE_FRESHNESS_MARGIN_MS = 60_000

function sessionStore(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null // storage blocked (private mode / iframe) — sign per session-in-memory only
  }
}

export function getCachedOrdersReadAuth(wallet: string): OrdersReadAuth | null {
  const store = sessionStore()
  if (!store) return null
  try {
    const raw = store.getItem(cacheKey(wallet))
    if (!raw) return null
    const parsed = JSON.parse(raw) as OrdersReadAuth
    if (typeof parsed?.issuedAt !== 'number' || typeof parsed?.signature !== 'string') return null
    if (Date.now() - parsed.issuedAt * 1000 > ORDERS_READ_TTL_MS - CACHE_FRESHNESS_MARGIN_MS) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function storeOrdersReadAuth(wallet: string, auth: { issuedAt: number; signature: string }): void {
  sessionStore()?.setItem(cacheKey(wallet), JSON.stringify(auth))
}

/** Headers for an orders read, or null when the session has no valid auth. */
export function ordersReadHeaders(wallet: string): Record<string, string> | null {
  const cached = getCachedOrdersReadAuth(wallet)
  if (!cached) return null
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(cached.issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: cached.signature,
  }
}

type SignTypedDataFn = (typed: ReturnType<typeof buildOrdersReadTypedData>) => Promise<string>

/** In-flight dedupe: N concurrent panels → ONE wallet prompt. */
const inflight = new Map<string, Promise<'ok' | 'denied'>>()
/** Session denial memory: a rejected prompt is not re-shown automatically. */
const denied = new Set<string>()

/**
 * Ensure this session holds a valid read signature for `wallet` — signing at
 * most once. Returns 'denied' when the user rejected (remembered for the
 * session; clear via _readAuthInternal.clearDenial / retryOrdersReadAuth).
 */
export async function ensureOrdersReadAuth(
  wallet: string,
  signTypedDataAsync: SignTypedDataFn,
): Promise<'ok' | 'denied'> {
  const key = wallet.toLowerCase()
  if (getCachedOrdersReadAuth(wallet)) return 'ok'
  if (denied.has(key)) return 'denied'
  const pending = inflight.get(key)
  if (pending) return pending

  const attempt = (async (): Promise<'ok' | 'denied'> => {
    try {
      const issuedAt = Math.floor(Date.now() / 1000)
      const signature = await signTypedDataAsync(buildOrdersReadTypedData(wallet, issuedAt))
      if (typeof signature !== 'string' || !signature.startsWith('0x')) {
        denied.add(key)
        return 'denied'
      }
      storeOrdersReadAuth(wallet, { issuedAt, signature })
      return 'ok'
    } catch {
      denied.add(key) // user rejected (or wallet errored) — don't popup-spam
      return 'denied'
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, attempt)
  return attempt
}

/** Forget a session denial so the UI can offer an explicit "sign to view" retry. */
export function retryOrdersReadAuth(wallet: string): void {
  denied.delete(wallet.toLowerCase())
}

// ── Test-only ───────────────────────────────────────────────────────────────
export const _readAuthInternal = {
  reset() {
    inflight.clear()
    denied.clear()
  },
  clearDenial(wallet: string) {
    denied.delete(wallet.toLowerCase())
  },
}
