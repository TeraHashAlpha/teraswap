// @vitest-environment jsdom
/**
 * [A100] The Orders tab's read-signature flow end to end in the hook: the REAL useOrderEngine, the REAL list fetchers
 * (fetchUserOrders, fetchActiveOrders), the REAL fills client and read-auth, against a mock server that behaves like the
 * routes: an orders read answers 200 only with the read signature of the wallet its URL names, else 401. The server notes
 * for every request whose signature it carried ('none', the wallet's 'own', or a 'foreign' one), never the value.
 *
 * wagmi is a mock that behaves like wagmi with an injected wallet: it signs with the account it is told to use and refuses
 * (ConnectorAccountNotFoundError) an account that is not the connected one. Real signatures (viem local accounts).
 *
 * R2-1: a foreign entry cached under the connected wallet is dropped unsent: one prompt, the list loads, poll and fills
 *       carry the wallet's own signature; with its owner not connected, no request carries it either.
 * R2-3: a wallet whose signature does not recover to it (a smart-contract account: here a third key answers for it) is
 *       asked ONCE: not again on a remount, on the poll or on a fills read; the "Sign to view" state shows, and using it
 *       asks once more. That state follows the connected account (owner decision 2026-11-20).
 * R2-2: 'unavailable' (the wallet the read names is not the connected account any more) is not a refusal: the hook ends
 *       that read quietly and never raises "Sign to view" for it (useOrderEngine.ts, `if (outcome === 'unavailable') return []`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// Published Anvil/Hardhat default account #0 (value-allowlisted in .gitleaks.toml): NOT a secret. B and C are generated per run.
const KEY_A = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const KEY_B = privateKeyToAccount(generatePrivateKey())
const KEY_C = privateKeyToAccount(generatePrivateKey())
const A = KEY_A.address
const B = KEY_B.address

/**
 * `answers[account]`: how the wallet answers a prompt for that (lowercased) account. Default: with its own key.
 * 'smart' = a third key answers (a smart-contract account: the signature never recovers to the account);
 * 'refuse' = the user rejects the prompt.
 */
const wallet = vi.hoisted(() => ({
  /** The account React (useAccount) reports. */
  connected: undefined as string | undefined,
  /** The account the wallet itself is on, when it has already moved and React has not re-rendered yet (default: `connected`). */
  inWallet: undefined as string | undefined,
  answers: {} as Record<string, 'smart' | 'refuse'>,
}))
const wagmiSign = vi.hoisted(() => vi.fn<(args: Record<string, unknown>) => Promise<string>>())
/** [R2-2] What each of the HOOK's own ensureOrdersReadAuth calls resolved to: [wallet, outcome]. The real function does the work. */
const outcomes = vi.hoisted(() => [] as Array<[string, string]>)

vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: vi.fn().mockResolvedValue(undefined) }),
  useAccount: () => ({ address: wallet.connected }),
  useChainId: () => 1,
  useSignTypedData: () => ({ signTypedDataAsync: wagmiSign }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useReadContract: () => ({ data: 0n, isLoading: false, refetch: vi.fn().mockResolvedValue({ data: 0n }) }),
}))
// The list fetchers stay REAL (they build the read headers); the poll interval is shortened, and the hook's calls of the
// REAL ensureOrdersReadAuth are noted with their outcome (so a test can wait for "the hook was told 'unavailable'").
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  const ensureOrdersReadAuth: typeof actual.ensureOrdersReadAuth = (w, sign) => {
    const result = actual.ensureOrdersReadAuth(w, sign)
    void result.then((outcome) => void outcomes.push([w.toLowerCase(), outcome]))
    return result
  }
  return { ...actual, ORDER_POLL_INTERVAL_MS: 40, ensureOrdersReadAuth }
})

import { renderHook, act, waitFor } from '@testing-library/react'
import { useOrderEngine, flushOrderWrites } from './useOrderEngine'
import type { OrderRow } from '@/lib/order-engine'
import {
  ORDERS_READ_HEADER_ISSUED,
  ORDERS_READ_HEADER_SIGNATURE,
  _readAuthInternal,
  buildOrdersReadTypedData,
  getCachedOrdersReadAuth,
  retryOrdersReadAuth,
  storeOrdersReadAuth,
  verifyOrdersReadAccess,
} from '@/lib/order-engine/read-auth'
import { fetchOrderExecutions } from '@/lib/order-engine/executions-client'

// Event-driven waits: each returns as soon as its condition holds. The ceiling is far above what a loaded machine needs
// (the library's default of 1 s is not, with real signature recovery in the path); the tests' own timeout matches it.
vi.setConfig({ testTimeout: 60_000 })
const until = (check: () => void) => waitFor(check, { timeout: 15_000, interval: 20 })

const KEYS: Record<string, typeof KEY_A> = { [A.toLowerCase()]: KEY_A, [B.toLowerCase()]: KEY_B }

function liveDca(owner: string, n: number): OrderRow {
  const hash = `0x${String(n).repeat(64)}`
  return {
    id: `ord-${n}`, wallet: owner.toLowerCase(), order_hash: hash, order_type: 'dca', status: 'active', chain_id: 1,
    token_in: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', token_out: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    token_in_symbol: 'USDC', token_out_symbol: 'WETH', token_in_decimals: 6, token_out_decimals: 18,
    amount_in: '100000000', min_amount_out: '0', target_price: '0', price_feed: '0x0000000000000000000000000000000000000000',
    expiry: String(Math.floor(Date.now() / 1000) + 86_400), nonce: 1, router: '0x0000000000000000000000000000000000000000',
    dca_interval: 3600, dca_total: 5, dca_executed: 2, order_data: { owner, orderType: 2 }, tx_hash: null, amount_out: null, error: null,
    created_at: new Date().toISOString(), executed_at: null,
  } as OrderRow
}

type Seen = { route: 'list' | 'poll' | 'fills'; wallet: string; sig: 'none' | 'own' | 'foreign' }
let seen: Seen[] = []
let rows: Record<string, OrderRow[]> = {}
/** [R2-2] The server holds its answer to the NEXT list read of `wallet` until `open` resolves (a request in flight). */
let gate: { wallet: string; open: Promise<void> } | null = null
const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
  const u = new URL(url, 'http://localhost')
  const w = (u.searchParams.get('wallet') ?? '').toLowerCase()
  const h = init?.headers
  let sig: Seen['sig'] = 'none'
  if (h?.[ORDERS_READ_HEADER_SIGNATURE]) {
    sig = (await verifyOrdersReadAccess({ wallet: w, issuedAt: h[ORDERS_READ_HEADER_ISSUED], signature: h[ORDERS_READ_HEADER_SIGNATURE] })).ok ? 'own' : 'foreign'
  }
  const route: Seen['route'] = u.pathname === '/api/orders' ? (u.searchParams.get('hashes') ? 'poll' : 'list') : 'fills'
  if (gate && route === 'list' && w === gate.wallet) {
    const held = gate
    gate = null
    await held.open
  }
  seen.push({ route, wallet: w, sig })
  if (sig !== 'own') return new Response(JSON.stringify({ code: 'READ_AUTH_REQUIRED' }), { status: 401 })
  if (route === 'fills') return new Response(JSON.stringify({ executions: [{ id: 'f1', execution_number: 1, status: 'confirmed' }], order: null }), { status: 200 })
  return new Response(JSON.stringify({ orders: rows[w] ?? [] }), { status: 200 })
})
const of = (route: Seen['route'], w?: string) => seen.filter((s) => s.route === route && (!w || s.wallet === w.toLowerCase()))
/** How many times the wallet was asked to sign for `account`. */
const promptsFor = (account: string) => wagmiSign.mock.calls.filter((c) => String(c[0].account).toLowerCase() === account.toLowerCase()).length
/** Wait until `n` MORE status polls of `w` have been answered (the poll runs every 40 ms here; 10 s in the app). */
async function morePolls(w: string, n: number) {
  const from = of('poll', w).length
  await until(() => expect(of('poll', w).length).toBeGreaterThanOrEqual(from + n))
}

/** An entry under `owner` signed by `by` (B's signature under A = what a build without the recover check left behind). */
async function plant(owner: string, by: typeof KEY_A): Promise<void> {
  const issuedAt = Math.floor(Date.now() / 1000)
  storeOrdersReadAuth(owner, { issuedAt, signature: await by.signTypedData(buildOrdersReadTypedData(owner, issuedAt)) })
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  _readAuthInternal.reset()
  _readAuthInternal.clearSigner()
  seen = []
  rows = { [A.toLowerCase()]: [liveDca(A, 1)] }
  gate = null
  outcomes.length = 0
  wallet.connected = A
  wallet.inWallet = undefined
  wallet.answers = {}
  wagmiSign.mockReset()
  // wagmi with an injected wallet: signs with the account it is told to use, refuses one the wallet is not on.
  wagmiSign.mockImplementation(async (args) => {
    const account = String(args.account ?? wallet.connected).toLowerCase()
    const holds = wallet.inWallet ?? wallet.connected
    if (!holds || account !== holds.toLowerCase()) {
      const err = new Error(`Account "${account}" not found for connector`)
      err.name = 'ConnectorAccountNotFoundError'
      throw err
    }
    if (wallet.answers[account] === 'refuse') throw new Error('User rejected the request')
    const { account: _a, ...typed } = args
    const key = wallet.answers[account] === 'smart' ? KEY_C : KEYS[account]
    return key.signTypedData(typed as Parameters<typeof KEY_A.signTypedData>[0])
  })
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await flushOrderWrites()
})

describe('[A100 R2-1] a foreign entry cached under a wallet is never sent by the Orders tab', () => {
  it('its owner IS connected: dropped unsent, ONE prompt, the list loads, the poll and the fills carry the owner\'s own signature', async () => {
    await plant(A, KEY_B)
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.orders).toHaveLength(1))
    await until(() => expect(of('poll').length).toBeGreaterThanOrEqual(2))
    let fills!: Response
    await act(async () => { fills = await fetchOrderExecutions('ord-1', A, { live: true }) })
    expect(fills.status).toBe(200) // the fills show
    expect(seen.filter((s) => s.sig === 'foreign')).toEqual([]) // 0 requests carried it
    expect(of('list').map((s) => s.sig)).toEqual(['none', 'own']) // unsigned first (the entry was dropped), then the owner's own
    expect(of('poll').every((s) => s.sig === 'own')).toBe(true)
    expect(of('fills').map((s) => s.sig)).toEqual(['own'])
    expect(wagmiSign).toHaveBeenCalledTimes(1)
    expect(String(wagmiSign.mock.calls[0][0].account).toLowerCase()).toBe(A.toLowerCase())
    expect(view.result.current.readAuthDenied).toBe(false)
    const kept = getCachedOrdersReadAuth(A)!
    expect((await verifyOrdersReadAccess({ wallet: A, issuedAt: kept.issuedAt, signature: kept.signature })).ok).toBe(true)
    view.unmount()
  })

  it('its owner is NOT connected (B is, A\'s live order still on screen): the fills reads of A\'s order carry nothing, nobody is asked for A', async () => {
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.orders).toHaveLength(1))
    wallet.connected = B
    view.rerender()
    await until(() => expect(of('list', B).length).toBeGreaterThan(0)) // B's own list read (B signs for B)
    wagmiSign.mockClear()
    seen = []
    await plant(A, KEY_B)
    for (const live of [true, false, true]) {
      let res!: Response
      await act(async () => { res = await fetchOrderExecutions('ord-1', A, { live }) })
      expect(res.status).toBe(401)
      await plant(A, KEY_B) // planted again before the next read: every read verifies what it is about to send
    }
    expect(of('fills', A).map((s) => s.sig)).toEqual(['none', 'none', 'none'])
    expect(seen.filter((s) => s.sig === 'foreign')).toEqual([])
    expect(wagmiSign.mock.calls.filter((c) => String(c[0].account).toLowerCase() === A.toLowerCase())).toEqual([])
    expect(_readAuthInternal.isDenied(A)).toBe(false)
    view.unmount()
  })
})

describe('[A100 R2-3] a wallet whose signature does not recover to it is asked ONCE, then shown "Sign to view"', () => {
  it('a smart-contract account from the start: one prompt on the first read; two more mounts of the Orders tab (tab cycles) ask nothing; "Sign to view" shows on each', async () => {
    wallet.answers[A.toLowerCase()] = 'smart'
    const first = renderHook(() => useOrderEngine())
    await until(() => expect(first.result.current.readAuthDenied).toBe(true))
    expect(promptsFor(A)).toBe(1)
    expect(first.result.current.orders).toEqual([]) // the server never accepts its signature: nothing of the live order is shown
    first.unmount()
    for (let cycle = 0; cycle < 2; cycle++) {
      const again = renderHook(() => useOrderEngine())
      await until(() => expect(again.result.current.readAuthDenied).toBe(true))
      again.unmount()
    }
    expect(promptsFor(A)).toBe(1)
    expect(of('list', A).map((s) => s.sig)).toEqual(['none', 'none', 'none']) // three reads, nothing foreign sent, nothing cached
    expect(getCachedOrdersReadAuth(A)).toBeNull()
    expect(_readAuthInternal.isMismatched(A)).toBe(true)
    expect(_readAuthInternal.isDenied(A)).toBe(false)
  })

  it('a smart-contract account B switched in while A\'s live order stays listed: ONE prompt, the poll and the fills reads ask nothing; "Sign to view" asks once more', async () => {
    wallet.answers[B.toLowerCase()] = 'smart'
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.orders).toHaveLength(1))
    expect(view.result.current.readAuthDenied).toBe(false)
    wallet.connected = B
    view.rerender()
    await until(() => expect(view.result.current.readAuthDenied).toBe(true)) // the existing "Sign to view" state
    expect(view.result.current.orders).toHaveLength(1) // A's order is still listed, so the status poll keeps running, as B
    await morePolls(B, 5)
    for (const live of [true, false]) {
      await act(async () => { await fetchOrderExecutions('ord-9', B, { live }) }) // B's own fills reads
      await act(async () => { await fetchOrderExecutions('ord-1', A, { live }) }) // the fills of A's order, still on screen
    }
    expect(promptsFor(B)).toBe(1) // not one per poll (cc282e0a: one every 10 s)
    expect(promptsFor(A)).toBe(1) // A's own first read; nothing after B connected
    expect(seen.filter((s) => s.sig === 'foreign')).toEqual([])
    expect(_readAuthInternal.isMismatched(B)).toBe(true)

    await act(async () => { await view.result.current.requestOrdersReadAuth() }) // the user uses "Sign to view"
    expect(promptsFor(B)).toBe(2)
    expect(view.result.current.readAuthDenied).toBe(true) // still does not recover: the state stays
    await morePolls(B, 5)
    expect(promptsFor(B)).toBe(2) // and the poll still asks nothing
    view.unmount()
  })

  it('the "Sign to view" state follows the connected account: up for smart-contract B, down for A (whose orders load), up again for B, no new prompt', async () => {
    wallet.answers[B.toLowerCase()] = 'smart'
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.orders).toHaveLength(1))
    wallet.connected = B
    view.rerender()
    await until(() => expect(view.result.current.readAuthDenied).toBe(true))
    wallet.connected = A
    view.rerender()
    expect(view.result.current.readAuthDenied).toBe(false) // at once: it was B's
    await morePolls(A, 3) // A's reads go on with its cached signature
    expect(view.result.current.readAuthDenied).toBe(false)
    wallet.connected = B
    view.rerender()
    expect(view.result.current.readAuthDenied).toBe(true)
    await morePolls(B, 3)
    expect(view.result.current.readAuthDenied).toBe(true)
    expect([promptsFor(A), promptsFor(B)]).toEqual([1, 1])
    view.unmount()
  })

  it('the same after a REFUSAL: A refused, B (whose signature is already cached) connects: the state is down, although nothing was signed to lower it', async () => {
    wallet.connected = B
    rows = { [A.toLowerCase()]: [liveDca(A, 1)], [B.toLowerCase()]: [liveDca(B, 2)] }
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.orders.map((o) => o.id)).toEqual(['ord-2'])) // B signed once; its signature is cached
    wallet.answers[A.toLowerCase()] = 'refuse'
    wallet.connected = A
    view.rerender()
    await until(() => expect(view.result.current.readAuthDenied).toBe(true))
    expect(_readAuthInternal.isDenied(A)).toBe(true)
    wallet.connected = B
    view.rerender()
    expect(view.result.current.readAuthDenied).toBe(false)
    await morePolls(B, 3)
    expect(view.result.current.readAuthDenied).toBe(false)
    expect([promptsFor(A), promptsFor(B)]).toEqual([1, 1])
    wallet.connected = A
    view.rerender()
    await until(() => expect(view.result.current.readAuthDenied).toBe(true)) // A's own read finds the refusal remembered
    expect(promptsFor(A)).toBe(1) // and does not ask again
    view.unmount()
  })
})

describe('[A100 R2-3] the "Sign to view" state comes DOWN when the wallet\'s own signature arrives', () => {
  it('"Sign to view" after a refusal, and this time the user signs: asked once more, the state is down, the list loads', async () => {
    wallet.answers[A.toLowerCase()] = 'refuse'
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.readAuthDenied).toBe(true))
    expect(view.result.current.orders).toEqual([])
    delete wallet.answers[A.toLowerCase()]
    await act(async () => { await view.result.current.requestOrdersReadAuth() })
    expect(view.result.current.readAuthDenied).toBe(false)
    await until(() => expect(view.result.current.orders).toHaveLength(1))
    expect(promptsFor(A)).toBe(2) // the refused prompt, and the one "Sign to view" raised
    expect(of('list', A).map((s) => s.sig)).toEqual(['none', 'own'])
    await morePolls(A, 3)
    expect(view.result.current.readAuthDenied).toBe(false)
    expect(promptsFor(A)).toBe(2)
    view.unmount()
  })

  it('"Sign to view" was used on ANOTHER Orders surface: this one\'s next poll signs through the shared path and lowers its own state', async () => {
    // B (its signature cached) has a live order listed; A connects and refuses: the state is up for A, and the poll goes on as A.
    wallet.connected = B
    rows = { [A.toLowerCase()]: [liveDca(A, 1)], [B.toLowerCase()]: [liveDca(B, 2)] }
    const view = renderHook(() => useOrderEngine())
    await until(() => expect(view.result.current.orders.map((o) => o.id)).toEqual(['ord-2']))
    wallet.answers[A.toLowerCase()] = 'refuse'
    wallet.connected = A
    view.rerender()
    await until(() => expect(view.result.current.readAuthDenied).toBe(true))
    await morePolls(A, 2) // each answered 401; the refusal is remembered, nobody is asked
    expect(promptsFor(A)).toBe(1)
    // On another mounted Orders surface the user uses "Sign to view" for A (the refusal is forgotten) and will sign.
    delete wallet.answers[A.toLowerCase()]
    retryOrdersReadAuth(A)
    await until(() => expect(view.result.current.readAuthDenied).toBe(false)) // lowered by this surface's own next poll
    expect(promptsFor(A)).toBe(2) // that poll's prompt: one, shared
    await morePolls(A, 2)
    expect(of('poll', A).slice(-2).map((s) => s.sig)).toEqual(['own', 'own'])
    expect(promptsFor(A)).toBe(2)
    view.unmount()
  })
})

// The line under test: useOrderEngine.ts `if (outcome === 'unavailable') return []` (:518 at cc282e0a, :524 here). Without it
// the next statement raises "Sign to view" for a wallet that refused nothing; both tests below then fail.
describe('[A100 R2-2] \'unavailable\' is not a refusal: the hook never raises "Sign to view" for it', () => {
  it('the wallet moved to another account before React re-rendered (wagmi refuses the account): the read ends quietly, "Sign to view" never shows, nothing is remembered', async () => {
    wallet.inWallet = B // the wallet is on B already; React still reports A
    const shown: boolean[] = []
    const view = renderHook(() => {
      const engine = useOrderEngine()
      shown.push(engine.readAuthDenied)
      return engine
    })
    await until(() => expect(outcomes).toEqual([[A.toLowerCase(), 'unavailable']])) // the hook's read of A was told so
    await until(() => expect(view.result.current.isLoading).toBe(false)) // and that read has ended
    expect(view.result.current.readAuthDenied).toBe(false)
    expect(shown.includes(true)).toBe(false) // not even for one render
    expect(view.result.current.orders).toEqual([])
    expect(promptsFor(A)).toBe(1) // wagmi was asked for A once, and refused the account
    expect(of('list', A).map((s) => s.sig)).toEqual(['none']) // no retry: there is nothing to send
    expect([_readAuthInternal.isDenied(A), _readAuthInternal.isMismatched(A)]).toEqual([false, false])
    view.unmount()
  })

  it('A\'s list read is still in flight when the account switches to B: its 401 asks nobody, and back on A "Sign to view" does not show', async () => {
    let open!: () => void
    gate = { wallet: A.toLowerCase(), open: new Promise<void>((resolve) => (open = resolve)) }
    const shown: Array<[string | undefined, boolean]> = []
    const view = renderHook(() => {
      const engine = useOrderEngine()
      shown.push([wallet.connected, engine.readAuthDenied])
      return engine
    })
    await until(() => expect(fetchMock).toHaveBeenCalled()) // A's unsigned list read is out; the server holds its answer
    wallet.connected = B
    view.rerender()
    await until(() => expect(of('list', B).map((s) => s.sig)).toEqual(['none', 'own'])) // B's own read: asked once, signed
    open() // A's 401 arrives now, with B connected
    await until(() => expect(outcomes.some(([w, o]) => w === A.toLowerCase() && o === 'unavailable')).toBe(true))
    expect(promptsFor(A)).toBe(0) // the hook's own check: wagmi was never asked for A
    wallet.connected = A
    view.rerender()
    expect(view.result.current.readAuthDenied).toBe(false) // at once, before A's new read answers
    await until(() => expect(view.result.current.orders).toHaveLength(1)) // A reads again: asked once, its order loads
    expect(shown.filter(([, up]) => up)).toEqual([]) // "Sign to view" was never up, for either account
    expect([promptsFor(A), promptsFor(B)]).toEqual([1, 1])
    expect([_readAuthInternal.isDenied(A), _readAuthInternal.isMismatched(A)]).toEqual([false, false])
    view.unmount()
  })
})
