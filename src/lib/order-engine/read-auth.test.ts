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
  retryOrdersReadAuth,
  OrdersReadSignerUnavailableError,
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

describe('verifyOrdersReadAccess: the server-side gate', () => {
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

  // [A100 R2-1] ordersReadHeaders is async now (it verifies the entry before handing it out): the calls are awaited.
  it('ordersReadHeaders returns the two headers when cached, null when not', async () => {
    expect(await ordersReadHeaders(WALLET)).toBeNull()
    const auth = await signReadAuth()
    storeOrdersReadAuth(WALLET, auth)
    const headers = (await ordersReadHeaders(WALLET)) as Record<string, string>
    expect(headers[ORDERS_READ_HEADER_ISSUED]).toBe(String(auth.issuedAt))
    expect(headers[ORDERS_READ_HEADER_SIGNATURE]).toBe(auth.signature)
  })
})

describe('[A100 R2-1] ordersReadHeaders hands out only the wallet\'s OWN cached signature', () => {
  it('an entry under the wallet signed by ANOTHER account gives no headers and is removed (never sent, whoever is connected)', async () => {
    const foreign = await signReadAuth(otherAccount, WALLET) // the other account's signature over a message naming WALLET
    storeOrdersReadAuth(WALLET, foreign)
    expect(getCachedOrdersReadAuth(WALLET)?.signature).toBe(foreign.signature) // it IS in the cache…
    expect(await ordersReadHeaders(WALLET)).toBeNull() // …and is not handed out
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull() // …and is gone
  })

  it('an entry that is the other account\'s own read signature (its message, its key) is not this wallet\'s either', async () => {
    storeOrdersReadAuth(WALLET, await signReadAuth(otherAccount, otherAccount.address))
    expect(await ordersReadHeaders(WALLET)).toBeNull()
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
  })

  it('an entry that is no signature at all gives no headers and is removed', async () => {
    storeOrdersReadAuth(WALLET, { issuedAt: nowSec(), signature: `0x${'ab'.repeat(65)}` })
    expect(await ordersReadHeaders(WALLET)).toBeNull()
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
  })

  it('the wallet\'s own entry is handed out as it is, every time, and stays cached', async () => {
    const own = await signReadAuth()
    storeOrdersReadAuth(WALLET, own)
    for (let i = 0; i < 3; i++) {
      expect(await ordersReadHeaders(WALLET.toLowerCase())).toEqual({
        [ORDERS_READ_HEADER_ISSUED]: String(own.issuedAt),
        [ORDERS_READ_HEADER_SIGNATURE]: own.signature,
      })
    }
    expect(getCachedOrdersReadAuth(WALLET)?.signature).toBe(own.signature)
  })
})

describe('ensureOrdersReadAuth: sign once per session', () => {
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

describe('[A100 R2-3] a wallet whose signature does not recover to it is asked ONCE', () => {
  /** A signer that counts its prompts and answers each with `answer`. */
  function counting(answer: (typed: Parameters<typeof account.signTypedData>[0]) => Promise<string>) {
    const calls = { n: 0 }
    const sign = async (typed: unknown) => {
      calls.n++
      return answer(typed as Parameters<typeof account.signTypedData>[0])
    }
    return { calls, sign }
  }
  // What a smart-contract account or a wallet answering with another account gives: a signature by a DIFFERENT key.
  const answersAsOther = () => counting((typed) => otherAccount.signTypedData(typed))

  it('three reads, ONE prompt: the outcome is \'mismatch\', remembered for the wallet, nothing is cached and it is not a refusal', async () => {
    const { calls, sign } = answersAsOther()
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('mismatch')
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('mismatch')
    expect(await ensureOrdersReadAuth(WALLET.toLowerCase(), sign)).toBe('mismatch')
    expect(calls.n).toBe(1)
    expect(getCachedOrdersReadAuth(WALLET)).toBeNull()
    expect(await ordersReadHeaders(WALLET)).toBeNull()
    expect(_readAuthInternal.isMismatched(WALLET)).toBe(true)
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('three reads AT ONCE: one prompt, all three told \'mismatch\'', async () => {
    const { calls, sign } = answersAsOther()
    const outcomes = await Promise.all([ensureOrdersReadAuth(WALLET, sign), ensureOrdersReadAuth(WALLET, sign), ensureOrdersReadAuth(WALLET, sign)])
    expect(outcomes).toEqual(['mismatch', 'mismatch', 'mismatch'])
    expect(calls.n).toBe(1)
  })

  it('a signature that is not 65 bytes at all (a smart wallet\'s wrapped signature) is a mismatch too, asked once', async () => {
    const { calls, sign } = counting(async () => `0x${'ab'.repeat(320)}`)
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('mismatch')
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('mismatch')
    expect(calls.n).toBe(1)
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('"Sign to view" (retryOrdersReadAuth) asks once more, and only once: a second mismatch is remembered again', async () => {
    const { calls, sign } = answersAsOther()
    await ensureOrdersReadAuth(WALLET, sign)
    retryOrdersReadAuth(WALLET)
    expect(_readAuthInternal.isMismatched(WALLET)).toBe(false)
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('mismatch')
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('mismatch')
    expect(calls.n).toBe(2)
  })

  it('after "Sign to view" a signature that DOES recover is stored: \'ok\', the mismatch is gone, no further prompt', async () => {
    const wrong = answersAsOther()
    await ensureOrdersReadAuth(WALLET, wrong.sign)
    retryOrdersReadAuth(WALLET)
    const right = counting((typed) => account.signTypedData(typed))
    expect(await ensureOrdersReadAuth(WALLET, right.sign)).toBe('ok')
    expect(await ensureOrdersReadAuth(WALLET, right.sign)).toBe('ok')
    expect(right.calls.n).toBe(1)
    expect(_readAuthInternal.isMismatched(WALLET)).toBe(false)
    expect((await ordersReadHeaders(WALLET))?.[ORDERS_READ_HEADER_SIGNATURE]).toBe(getCachedOrdersReadAuth(WALLET)!.signature)
  })

  it('the memory is per wallet: another wallet is still asked', async () => {
    const { sign } = answersAsOther()
    await ensureOrdersReadAuth(WALLET, sign)
    const theirs = counting((typed) => otherAccount.signTypedData(typed))
    expect(await ensureOrdersReadAuth(otherAccount.address, theirs.sign)).toBe('ok')
    expect(theirs.calls.n).toBe(1)
    expect(_readAuthInternal.isMismatched(otherAccount.address)).toBe(false)
  })

  it('\'unavailable\' is ONLY the signer saying the wallet is not connected: nothing is remembered and the next read asks', async () => {
    const calls = { n: 0 }
    const notConnected = async () => {
      calls.n++
      throw new OrdersReadSignerUnavailableError()
    }
    expect(await ensureOrdersReadAuth(WALLET, notConnected)).toBe('unavailable')
    expect(await ensureOrdersReadAuth(WALLET, notConnected)).toBe('unavailable')
    expect(calls.n).toBe(2) // not remembered: each read reaches the signer
    expect(_readAuthInternal.isMismatched(WALLET)).toBe(false)
    expect(_readAuthInternal.isDenied(WALLET)).toBe(false)
  })

  it('a refusal stays a refusal (\'denied\'), not a mismatch', async () => {
    const { calls, sign } = counting(async () => {
      throw new Error('User rejected the request')
    })
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('denied')
    expect(await ensureOrdersReadAuth(WALLET, sign)).toBe('denied')
    expect(calls.n).toBe(1)
    expect(_readAuthInternal.isMismatched(WALLET)).toBe(false)
  })
})

describe('ReadAuthRequiredError', () => {
  it('is a distinguishable error type for the 401 retry flow', () => {
    const err = new ReadAuthRequiredError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ReadAuthRequiredError')
  })
})
