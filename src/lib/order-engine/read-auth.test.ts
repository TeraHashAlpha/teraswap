// @vitest-environment jsdom
/**
 * [AUDIT-W6 / W6-M-01] Orders read-auth — per-session proof-of-wallet-ownership
 * for reading ACTIVE/PENDING conditional-order strategy.
 *
 * The client signs ONE lightweight SIWE-style EIP-712 message per session
 * (buildOrdersReadTypedData); the signature itself is the read token. The
 * server (verifyOrdersReadAccess) recovers the signer and requires
 * recovered === wallet, an issuedAt within TTL, and no future skew — the same
 * recoverTypedDataAddress trust anchor as the order write path.
 *
 * Real signatures (viem local account) — no crypto mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  buildOrdersReadTypedData,
  verifyOrdersReadAccess,
  getCachedOrdersReadAuth,
  storeOrdersReadAuth,
  ordersReadHeaders,
  ensureOrdersReadAuth,
  ReadAuthRequiredError,
  ORDERS_READ_TTL_MS,
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  _readAuthInternal,
} from './read-auth'

// Published Anvil/Hardhat default account #0 key — a throwaway local-dev
// fixture, value-allowlisted in .gitleaks.toml (NOT a secret).
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const account = privateKeyToAccount(PK)
const WALLET = account.address // checksummed
const OTHER_PK = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const otherAccount = privateKeyToAccount(OTHER_PK)

const nowSec = () => Math.floor(Date.now() / 1000)

async function signReadAuth(signer = account, wallet: string = WALLET, issuedAt = nowSec()) {
  const typed = buildOrdersReadTypedData(wallet, issuedAt)
  const signature = await signer.signTypedData(typed)
  return { issuedAt, signature }
}

beforeEach(() => {
  sessionStorage.clear()
  _readAuthInternal.reset()
})

describe('verifyOrdersReadAccess — the server-side gate', () => {
  it('accepts a fresh signature from the wallet owner', async () => {
    const { issuedAt, signature } = await signReadAuth()
    const res = await verifyOrdersReadAccess({ wallet: WALLET, issuedAt, signature })
    expect(res.ok).toBe(true)
  })

  it('binds case-insensitively: signed for checksummed wallet, queried lowercase', async () => {
    const { issuedAt, signature } = await signReadAuth(account, WALLET)
    const res = await verifyOrdersReadAccess({
      wallet: WALLET.toLowerCase(),
      issuedAt,
      signature,
    })
    expect(res.ok).toBe(true)
  })

  it("rejects a signature from a DIFFERENT wallet (can't read someone else's orders)", async () => {
    // otherAccount signs a message claiming WALLET — recovery must not match.
    const { issuedAt, signature } = await signReadAuth(otherAccount, WALLET)
    const res = await verifyOrdersReadAccess({ wallet: WALLET, issuedAt, signature })
    expect(res.ok).toBe(false)
  })

  it('rejects an expired issuedAt (older than the TTL)', async () => {
    const stale = nowSec() - Math.ceil(ORDERS_READ_TTL_MS / 1000) - 60
    const { issuedAt, signature } = await signReadAuth(account, WALLET, stale)
    const res = await verifyOrdersReadAccess({ wallet: WALLET, issuedAt, signature })
    expect(res.ok).toBe(false)
  })

  it('rejects a future issuedAt beyond the clock-skew allowance', async () => {
    const future = nowSec() + 3600
    const { issuedAt, signature } = await signReadAuth(account, WALLET, future)
    const res = await verifyOrdersReadAccess({ wallet: WALLET, issuedAt, signature })
    expect(res.ok).toBe(false)
  })

  it('rejects missing or malformed inputs without throwing', async () => {
    expect((await verifyOrdersReadAccess({ wallet: WALLET, issuedAt: null, signature: null })).ok).toBe(false)
    expect((await verifyOrdersReadAccess({ wallet: WALLET, issuedAt: 'abc', signature: '0x1234' })).ok).toBe(false)
    expect(
      (await verifyOrdersReadAccess({ wallet: WALLET, issuedAt: nowSec(), signature: '0xnot-a-sig' })).ok,
    ).toBe(false)
  })
})

describe('session cache + headers (client side)', () => {
  it('stores and retrieves the auth per wallet, case-insensitively', async () => {
    const auth = await signReadAuth()
    storeOrdersReadAuth(WALLET, auth)
    expect(getCachedOrdersReadAuth(WALLET.toLowerCase())?.signature).toBe(auth.signature)
  })

  it('ignores a stale cached auth (expired entries are not reused)', async () => {
    const stale = nowSec() - Math.ceil(ORDERS_READ_TTL_MS / 1000) - 60
    storeOrdersReadAuth(WALLET, { issuedAt: stale, signature: '0xdeadbeef' })
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
  })

  it('ordersReadHeaders returns the two headers when cached, null when not', async () => {
    expect(ordersReadHeaders(WALLET)).toBeNull()
    const auth = await signReadAuth()
    storeOrdersReadAuth(WALLET, auth)
    const headers = ordersReadHeaders(WALLET) as Record<string, string>
    expect(headers[ORDERS_READ_HEADER_ISSUED]).toBe(String(auth.issuedAt))
    expect(headers[ORDERS_READ_HEADER_SIGNATURE]).toBe(auth.signature)
  })
})

describe('ensureOrdersReadAuth — sign once per session', () => {
  it('signs once, caches, and does not prompt again', async () => {
    let signCount = 0
    const signFn = async (typed: unknown) => {
      signCount++
      return account.signTypedData(typed as Parameters<typeof account.signTypedData>[0])
    }
    expect(await ensureOrdersReadAuth(WALLET, signFn)).toBe('ok')
    expect(await ensureOrdersReadAuth(WALLET, signFn)).toBe('ok')
    expect(signCount).toBe(1)
    // And the produced signature actually verifies server-side.
    const cached = getCachedOrdersReadAuth(WALLET)!
    const res = await verifyOrdersReadAccess({
      wallet: WALLET,
      issuedAt: cached.issuedAt,
      signature: cached.signature,
    })
    expect(res.ok).toBe(true)
  })

  it('dedupes concurrent callers into a single signature prompt', async () => {
    let signCount = 0
    const signFn = async (typed: unknown) => {
      signCount++
      await new Promise((r) => setTimeout(r, 20))
      return account.signTypedData(typed as Parameters<typeof account.signTypedData>[0])
    }
    const [a, b] = await Promise.all([
      ensureOrdersReadAuth(WALLET, signFn),
      ensureOrdersReadAuth(WALLET, signFn),
    ])
    expect(a).toBe('ok')
    expect(b).toBe('ok')
    expect(signCount).toBe(1)
  })

  it('returns denied when the user rejects, and remembers the denial for the session', async () => {
    let signCount = 0
    const rejectFn = async () => {
      signCount++
      throw new Error('User rejected the request')
    }
    expect(await ensureOrdersReadAuth(WALLET, rejectFn)).toBe('denied')
    // A later call does NOT re-prompt automatically (no popup spam)…
    expect(await ensureOrdersReadAuth(WALLET, rejectFn)).toBe('denied')
    expect(signCount).toBe(1)
    // …until the caller explicitly retries.
    _readAuthInternal.clearDenial(WALLET)
    const okFn = async (typed: unknown) =>
      account.signTypedData(typed as Parameters<typeof account.signTypedData>[0])
    expect(await ensureOrdersReadAuth(WALLET, okFn)).toBe('ok')
  })
})

describe('ReadAuthRequiredError', () => {
  it('is a distinguishable error type for the 401 retry flow', () => {
    const err = new ReadAuthRequiredError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ReadAuthRequiredError')
  })
})
