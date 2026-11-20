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
/** [fix/user-ip-privacy A76 S-6] Most order hashes one GET /api/orders?hashes= poll may name (the client splits a
 *  longer list into several requests; 50 hashes ≈ 3.4 KB of query string). */
export const ORDER_POLL_MAX_HASHES = 50
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
  if (ageMs > ORDERS_READ_TTL_MS) return { ok: false, error: 'Read signature expired: sign again' }
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

function dropOrdersReadAuth(wallet: string): void {
  try {
    sessionStore()?.removeItem(cacheKey(wallet))
  } catch {
    /* storage blocked: nothing was cached */
  }
}

/**
 * [A97 S-1] Is `auth` WALLET's own read signature? The server's gate (verifyOrdersReadAccess: format, age, and the signer
 * recovered from the message naming `wallet` must be `wallet`), run in the browser. Never throws.
 */
export async function isOwnOrdersReadAuth(wallet: string, auth: { issuedAt: number; signature: string }): Promise<boolean> {
  return (await verifyOrdersReadAccess({ wallet, issuedAt: auth.issuedAt, signature: auth.signature })).ok
}

/**
 * [A97 S-1] The cached entry for `wallet` only when it is fresh AND recovers to `wallet`. An entry signed by any other
 * account (written before this check existed, or by anything else) is removed here, so it can never stand in for the
 * wallet's own signature and lock it out of its live orders.
 */
export async function getVerifiedOrdersReadAuth(wallet: string): Promise<OrdersReadAuth | null> {
  const cached = getCachedOrdersReadAuth(wallet)
  if (!cached) return null
  if (await isOwnOrdersReadAuth(wallet, cached)) return cached
  dropOrdersReadAuth(wallet)
  return null
}

/**
 * Headers for an orders read, or null when the session holds no signature of `wallet`'s own.
 *
 * [A100 R2-1] The ONE place a cached read signature becomes request headers, and it takes the entry through
 * getVerifiedOrdersReadAuth first: a signature that does not recover to `wallet` (a build without that check wrote such
 * entries under the wrong wallet in an account-switch race) is removed and never leaves the browser, whoever is connected.
 * Async because recovery is. No other file reads the cache or names the two headers (read-auth.send-guard.test.ts).
 */
export async function ordersReadHeaders(wallet: string): Promise<Record<string, string> | null> {
  const verified = await getVerifiedOrdersReadAuth(wallet)
  if (!verified) return null
  return {
    [ORDERS_READ_HEADER_ISSUED]: String(verified.issuedAt),
    [ORDERS_READ_HEADER_SIGNATURE]: verified.signature,
  }
}

export type SignTypedDataFn = (typed: ReturnType<typeof buildOrdersReadTypedData>) => Promise<string>

/**
 * [A97 S-1] Thrown by a signer when the wallet the message names is not the connected account (any more): nothing is
 * asked, nothing is cached and no denial is recorded, because the wallet's owner never saw a prompt to refuse.
 * [A100 R2-3] The ONLY source of the 'unavailable' outcome.
 */
export class OrdersReadSignerUnavailableError extends Error {
  constructor() {
    super('The wallet the read message names is not the connected account')
    this.name = 'OrdersReadSignerUnavailableError'
  }
}

/**
 * 'unavailable': the wallet is not the connected account (or nothing is connected): the signer threw
 *   OrdersReadSignerUnavailableError and nobody was asked; no cache, no denial, nothing remembered.
 * 'mismatch' [A100 R2-3]: the wallet WAS the connected account, it was asked, and what came back does not recover to it
 *   (a smart-contract account such as a Safe or a Coinbase Smart Wallet, whose signature the server's recover check can
 *   never accept, or a wallet that answered with another account). Remembered for the session like a refusal: the wallet
 *   is not asked again until its user chooses "Sign to view" (retryOrdersReadAuth).
 */
export type OrdersReadAuthOutcome = 'ok' | 'denied' | 'unavailable' | 'mismatch'

/** In-flight dedupe: N concurrent panels → ONE wallet prompt. */
const inflight = new Map<string, Promise<OrdersReadAuthOutcome>>()
/** Session denial memory: a rejected prompt is not re-shown automatically. */
const denied = new Set<string>()
/**
 * [A100 R2-3] Session memory of wallets that were asked and answered with a signature that does not recover to them. In
 * memory only, like `denied` (owner decision 2026-11-20): gone on a page load, never in browser storage.
 */
const mismatched = new Set<string>()

/**
 * Ensure this session holds a valid read signature for `wallet` — signing at
 * most once. Returns 'denied' when the user rejected (remembered for the
 * session; clear via _readAuthInternal.clearDenial / retryOrdersReadAuth).
 *
 * [A97 S-1] Only `wallet`'s own signature is ever cached: a cached entry is used only if it recovers to `wallet` (one that
 * does not is removed, getVerifiedOrdersReadAuth), and a new signature is stored only if it recovers to `wallet`.
 *
 * [A100 R2-3] A signature that does not recover to `wallet` is dropped and the wallet is remembered ('mismatch'): it was
 * asked once and is not asked again on the next read, poll or fills call, until retryOrdersReadAuth. It is not a refusal
 * (`denied` is untouched) and not 'unavailable' (that is only the signer saying the wallet is not connected: nobody was
 * asked, so nothing is remembered and the next call asks).
 */
export async function ensureOrdersReadAuth(
  wallet: string,
  signTypedDataAsync: SignTypedDataFn,
): Promise<OrdersReadAuthOutcome> {
  const key = wallet.toLowerCase()
  const running = inflight.get(key)
  if (running) return running
  if (await getVerifiedOrdersReadAuth(wallet)) return 'ok'
  if (denied.has(key)) return 'denied'
  if (mismatched.has(key)) return 'mismatch'
  const pending = inflight.get(key) // another caller may have started while the cache was being checked
  if (pending) return pending

  const attempt = (async (): Promise<OrdersReadAuthOutcome> => {
    try {
      const issuedAt = Math.floor(Date.now() / 1000)
      const signature = await signTypedDataAsync(buildOrdersReadTypedData(wallet, issuedAt))
      if (typeof signature !== 'string' || !signature.startsWith('0x')) {
        denied.add(key)
        return 'denied'
      }
      if (!(await isOwnOrdersReadAuth(wallet, { issuedAt, signature }))) {
        mismatched.add(key) // asked once; "Sign to view" asks again
        return 'mismatch'
      }
      storeOrdersReadAuth(wallet, { issuedAt, signature })
      return 'ok'
    } catch (err) {
      if (err instanceof OrdersReadSignerUnavailableError) return 'unavailable'
      denied.add(key) // user rejected (or wallet errored) — don't popup-spam
      return 'denied'
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, attempt)
  return attempt
}

/**
 * [A87b R2-1, A97 S-1/S-4] Who may sign a read message, registered by useOrderEngine (the one place that holds wagmi's
 * signTypedDataAsync for the Orders tab): ONE entry per mounted instance, { address, sign }, `address` being the account
 * that instance has connected. Other readers of live-order data (the fills fetch, executions-client.ts) reach the SAME
 * sign-once path through it, so they share the list's in-flight dedupe and denial memory and never need a wagmi hook.
 *
 * getOrdersReadSigner(wallet) returns a signer only when `wallet` IS a connected account: the fills of an order owned by
 * a wallet that is not connected (a list kept on screen across an account switch) never prompt the account that is.
 * An instance's unmount removes only its own entry; an instance with no connected account holds no entry.
 */
interface OrdersReadSignerEntry {
  address: string
  sign: SignTypedDataFn
}
const signers = new Map<object, OrdersReadSignerEntry>()
export function setOrdersReadSigner(owner: object, entry: { address?: string | null; sign: SignTypedDataFn } | null): void {
  if (!entry || !entry.address) {
    signers.delete(owner)
    return
  }
  signers.set(owner, { address: entry.address.toLowerCase(), sign: entry.sign })
}
export function getOrdersReadSigner(wallet: string): SignTypedDataFn | null {
  const key = wallet.toLowerCase()
  for (const entry of signers.values()) if (entry.address === key) return entry.sign
  return null
}

/** Forget a session denial, or a remembered mismatch [A100 R2-3], so the UI can offer an explicit "sign to view" retry. */
export function retryOrdersReadAuth(wallet: string): void {
  denied.delete(wallet.toLowerCase())
  mismatched.delete(wallet.toLowerCase())
}

// ── Test-only ───────────────────────────────────────────────────────────────
export const _readAuthInternal = {
  reset() {
    inflight.clear()
    denied.clear()
    mismatched.clear()
  },
  clearDenial(wallet: string) {
    denied.delete(wallet.toLowerCase())
  },
  isDenied(wallet: string) {
    return denied.has(wallet.toLowerCase())
  },
  isMismatched(wallet: string) {
    return mismatched.has(wallet.toLowerCase())
  },
  clearSigner() {
    signers.clear()
  },
  signerCount() {
    return signers.size
  },
}
