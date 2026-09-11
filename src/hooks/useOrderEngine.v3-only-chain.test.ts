// @vitest-environment jsdom
/**
 * [feat/arbitrum-dca-gates — third gate] useOrderEngine on a v3-ONLY chain, with REAL config.
 *
 * Before this commit `confirmOrder` and `confirmCancel` refused whenever `getOrderExecutor(chainId)`
 * — the **v2** executor — was null, and the CancelOrder ownership proof was signed under the v2
 * domain (`getOrderExecutorDomain`). Base has v2 + v3, so nothing fired there; Arbitrum One is v3-only
 * (ORDER_EXECUTOR_BY_CHAIN has no 42161), so every Arbitrum DCA stopped right after the approval with
 * "Conditional orders are not yet available on chain 42161." — the pin this branch's predecessor
 * left in DCAPanel.arbitrum-gates.test.tsx. Now both preconditions resolve the executor from the
 * ORDER's version (resolveSigningExecutor), and the proof domain is the one chain-level rule
 * getCancelOrderDomain (v2's where v2 exists, else v3's), shared with PATCH /api/orders/[id].
 *
 * NOTHING in `@/lib/order-engine/config` is mocked. The env slots are set BEFORE any import to the
 * addresses EXTRACTED from docs/DEPLOYMENTS.md's "OrderExecutor V3" rows (Base + Arbitrum One; never
 * typed — a failed extraction exits with the sentinel 42). The mainnet v3 slot is set to a dummy on
 * purpose: it proves 42161/8453 resolve through the ELIGIBILITY list, and that mainnet stays dark
 * however the environment is set.
 *
 * Three chains, one hook, the same fixture:
 *   42161  create → confirm signs under {name, version "3", chainId 42161, verifyingContract = the
 *          DEPLOYMENTS.md Arbitrum V3}; cancel → confirmCancel sends cancelOrder() to THAT address
 *          with the V3 ABI and the SAME struct that was signed (same EIP-712 digest ⇒ same
 *          getOrderHash on the same contract), and signs the Supabase ownership proof under the
 *          same v3 domain. Mass-cancel of a v3 DCA goes the same way, with no v2 leg.
 *   8453   unchanged, pinned by literal address: v3 DCA signs/cancels against the DEPLOYMENTS.md
 *          Base V3 while the ownership proof stays under the v2 domain of 0x135B…2598; a v2 order
 *          signs/cancels against 0x135B…2598 and proves under the same v2 domain.
 *   1      still refused for v3: a config asking for v3 is signed as v2 against 0xeFC3…f130 (no
 *          maxSlippageBps in the message); a stored v3-tagged order cannot even be frozen for cancel.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'

// ── Env BEFORE any import: config.ts reads the NEXT_PUBLIC_* slots at module load ──
const { ARBITRUM_V3, BASE_V3, ENV_BEFORE } = await vi.hoisted(async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const rows = readFileSync(resolve(process.cwd(), 'docs/DEPLOYMENTS.md'), 'utf8').split('\n')
  const extract = (chainLabel: RegExp) => {
    const row = rows.find(l => /\*\*OrderExecutor V3\*\*/.test(l) && chainLabel.test(l)) ?? ''
    return (row.match(/0x[0-9a-fA-F]{40}/) ?? [])[0]
  }
  const arbitrum = extract(/Arbitrum One \(42161\)/)
  const base = extract(/Base \(8453\)/)
  if (!arbitrum || !base || arbitrum.toLowerCase() === base.toLowerCase()) {
    console.error('SENTINEL 42: could not extract distinct Base + Arbitrum OrderExecutor V3 rows from docs/DEPLOYMENTS.md')
    process.exit(42)
  }
  const ENV_BEFORE = {
    arbitrum: process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM,
    base: process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE,
    mainnet: process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS,
  }
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM = arbitrum
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE = base
  // Dummy on purpose (see header) — distinct from both, or config's shared-address invariant throws.
  process.env.NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS = '0x3333333333333333333333333333333333333333'
  return { ARBITRUM_V3: arbitrum as `0x${string}`, BASE_V3: base as `0x${string}`, ENV_BEFORE }
})

const ARBITRUM = 42161
const BASE = 8453
const MAINNET = 1

// The two v2 executors this file pins by LITERAL, so a config edit that moved either would fail here.
const BASE_V2 = '0x135B339902Ea4E0fB4CF059961dc8856bA1D2598'
const MAINNET_V2 = '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130'

const mockSignTypedDataAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockWriteContractAsync = vi.fn<(args: unknown) => Promise<string>>()
const mockRefetchNonce = vi.fn<() => Promise<unknown>>()
const useChainIdMock = vi.fn<() => number>(() => ARBITRUM)
/** Every useReadContract call the hook makes — the evidence that the v2 nonce reads are fail-closed. */
const readContractCalls: Array<{ address?: string; functionName?: string; enabled?: boolean }> = []

const mockCreateOrderInSupabase = vi.fn()
const mockFetchUserOrders = vi.fn()
const mockFetchActiveOrders = vi.fn()
const mockCancelOrderInSupabase = vi.fn()
const mockSubscribeToOrders = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  useChainId: () => useChainIdMock(),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
  useReadContract: (opts: { address?: string; functionName?: string; query?: { enabled?: boolean } }) => {
    readContractCalls.push({ address: opts.address, functionName: opts.functionName, enabled: opts.query?.enabled })
    // A disabled read (no v2 executor on this chain) yields no data — exactly what wagmi returns.
    if (!opts.query?.enabled) return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
    if (opts.functionName === 'nonces') return { data: 5n, isLoading: false, refetch: mockRefetchNonce }
    if (opts.functionName === 'invalidatedNonces') return { data: 0n, isLoading: false, refetch: mockRefetchNonce }
    return { data: undefined, isLoading: false, refetch: mockRefetchNonce }
  },
}))

// Supabase I/O stubbed; getOrderExecutor / getOrderExecutorV3 / resolveSigningExecutor /
// getCancelOrderDomain and both domain fns are the REAL ones — that is the point of this file.
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return {
    ...actual,
    createOrderInSupabase: (...args: unknown[]) => mockCreateOrderInSupabase(...args),
    fetchUserOrders: (...args: unknown[]) => mockFetchUserOrders(...args),
    fetchActiveOrders: (...args: unknown[]) => mockFetchActiveOrders(...args),
    cancelOrderInSupabase: (...args: unknown[]) => mockCancelOrderInSupabase(...args),
    subscribeToOrders: (...args: unknown[]) => mockSubscribeToOrders(...args),
    ORDER_POLL_INTERVAL_MS: 100,
  }
})

import { renderHook, act } from '@testing-library/react'
import { hashTypedData } from 'viem'
import { useOrderEngine } from './useOrderEngine'
import {
  OrderType, PriceCondition, ORDER_EXECUTOR_ABI, ORDER_EXECUTOR_V3_ABI, ORDER_V3_EIP712_TYPES,
  CANCEL_ORDER_TYPES, getOrderExecutor, getOrderExecutorV3, getOrderExecutorDomain,
  getOrderExecutorV3Domain, getCancelOrderDomain, resolveSigningExecutor, getDefaultRouter,
  type CreateOrderConfig, type OrderRow,
} from '@/lib/order-engine'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const FAKE_SIG = '0x' + 'cc'.repeat(65)
const ROW_ID = 'row-under-test'

type Domain = { name: string; version: string; chainId: number; verifyingContract: string }
type SignCall = { domain: Domain; primaryType: string; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, unknown> }
type WriteCall = { address: string; abi: unknown; functionName: string; args: readonly unknown[] }

function makeConfig(chainId: number, overrides: Partial<CreateOrderConfig> = {}): CreateOrderConfig {
  return {
    tokenIn: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    tokenOut: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    amountIn: '1000000000000000000',
    minAmountOut: '2900000000',
    orderType: OrderType.DCA,
    condition: PriceCondition.ABOVE,
    targetPrice: '0',
    priceFeed: '0x0000000000000000000000000000000000000000',
    expirySeconds: 24 * 60 * 60,
    // The chain's REAL default router (Augustus V6 on Base and Arbitrum, 1inch on mainnet) — read
    // from the map, never typed, so the struct is what the panel would actually commit there.
    router: getDefaultRouter(chainId)!.address,
    routerDataHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
    dcaInterval: 3600,
    dcaTotal: 3,
    ...overrides,
  }
}

/** A stored v3 DCA row on `chainId`, as fetchUserOrders would return it. */
function makeV3Row(chainId: number): OrderRow {
  const router = getDefaultRouter(chainId)!.address
  return {
    id: ROW_ID,
    wallet: ADDRESS,
    order_hash: ('0x' + 'aa'.repeat(32)) as string,
    order_type: 'dca',
    status: 'active',
    chain_id: chainId,
    token_in: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    token_out: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount_in: '1000000000000000000',
    min_amount_out: '2900000000',
    target_price: '0',
    price_feed: '0x0000000000000000000000000000000000000000',
    price_condition: 'above',
    expiry: '9999999999',
    nonce: 0,
    router,
    dca_interval: 3600,
    dca_total: 3,
    dca_executed: 0,
    signature: FAKE_SIG,
    order_data: {
      owner: ADDRESS,
      tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountIn: '1000000000000000000',
      minAmountOut: '2900000000',
      maxSlippageBps: 300,
      orderType: 2,
      condition: 0,
      targetPrice: '0',
      priceFeed: '0x0000000000000000000000000000000000000000',
      expiry: '9999999999',
      nonce: '0',
      router,
      routerDataHash: '0x' + '00'.repeat(32),
      dcaInterval: '3600',
      dcaTotal: '3',
    },
    token_in_symbol: 'WETH',
    token_out_symbol: 'USDC',
    token_in_decimals: 18,
    token_out_decimals: 6,
    created_at: new Date().toISOString(),
    executed_at: null,
    amount_out: null,
    tx_hash: null,
    error: null,
  } as OrderRow
}

type Engine = ReturnType<typeof useOrderEngine>

async function createAndConfirm(result: { current: Engine }, config: CreateOrderConfig) {
  await act(async () => { await result.current.createOrder(config) })
  await act(async () => { await result.current.confirmOrder() })
}

async function settleLoad() {
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

const signCalls = () => mockSignTypedDataAsync.mock.calls.map(c => c[0] as SignCall)
const writeCalls = () => mockWriteContractAsync.mock.calls.map(c => c[0] as WriteCall)
const orderSign = () => signCalls().find(c => c.primaryType === 'Order')!
const proofSigns = () => signCalls().filter(c => c.primaryType === 'CancelOrder')

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  readContractCalls.length = 0
  vi.useFakeTimers()
  useChainIdMock.mockReturnValue(ARBITRUM)
  mockSignTypedDataAsync.mockResolvedValue(FAKE_SIG)
  mockWriteContractAsync.mockResolvedValue('0x' + 'ff'.repeat(32))
  mockRefetchNonce.mockResolvedValue({ data: 5n })
  mockFetchUserOrders.mockResolvedValue([])
  mockFetchActiveOrders.mockResolvedValue([])
  mockCreateOrderInSupabase.mockResolvedValue({ order_hash: '0x' + 'aa'.repeat(32) })
  // Drive the ownership-proof signer exactly as the real cancelOrderInSupabase does (supabase.ts:227):
  // resolve the row id, then ask the hook to sign for it. What the hook signs is what we assert.
  mockCancelOrderInSupabase.mockImplementation(async (_wallet: string, _hash: string, sign?: (id: string) => Promise<unknown>) => {
    if (sign) await sign(ROW_ID)
    return true
  })
  mockSubscribeToOrders.mockReturnValue(vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  // Leave the worker's environment as we found it — other files pin these slots UNSET.
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  restore('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_ARBITRUM', ENV_BEFORE.arbitrum)
  restore('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE', ENV_BEFORE.base)
  restore('NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS', ENV_BEFORE.mainnet)
})

describe('[third gate] the ONE rule, at the config level — real config, env = DEPLOYMENTS.md', () => {
  it('sanity: the fixture is what the header says (v2 map, v3 resolution per chain, distinct addresses)', () => {
    expect(getOrderExecutor(ARBITRUM)).toBeNull()
    expect(getOrderExecutorV3(ARBITRUM)).toBe(ARBITRUM_V3)
    expect(getOrderExecutor(BASE)).toBe(BASE_V2)
    expect(getOrderExecutorV3(BASE)).toBe(BASE_V3)
    expect(getOrderExecutor(MAINNET)).toBe(MAINNET_V2)
    expect(getOrderExecutorV3(MAINNET)).toBeNull() // env slot IS set — eligibility, not env, decides
    expect(new Set([ARBITRUM_V3, BASE_V3, BASE_V2, MAINNET_V2].map(a => a.toLowerCase())).size).toBe(4)
  })

  it('resolveSigningExecutor: a v3 order resolves v3 on 42161/8453 and null on 1; a v2 order resolves v2 on 8453/1 and null on 42161', () => {
    expect(resolveSigningExecutor(ARBITRUM, true)).toBe(ARBITRUM_V3)
    expect(resolveSigningExecutor(ARBITRUM, false)).toBeNull()
    expect(resolveSigningExecutor(BASE, true)).toBe(BASE_V3)
    expect(resolveSigningExecutor(BASE, false)).toBe(BASE_V2)
    expect(resolveSigningExecutor(MAINNET, true)).toBeNull()
    expect(resolveSigningExecutor(MAINNET, false)).toBe(MAINNET_V2)
  })

  it('getCancelOrderDomain: v2\'s domain where v2 exists (1, 8453 — the exact getOrderExecutorDomain object), else v3\'s (42161), else throws (10)', () => {
    expect(getCancelOrderDomain(MAINNET)).toEqual(getOrderExecutorDomain(MAINNET))
    expect(getCancelOrderDomain(MAINNET)).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: MAINNET, verifyingContract: MAINNET_V2 })
    expect(getCancelOrderDomain(BASE)).toEqual(getOrderExecutorDomain(BASE))
    expect(getCancelOrderDomain(BASE)).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: BASE, verifyingContract: BASE_V2 })
    expect(getCancelOrderDomain(ARBITRUM)).toEqual(getOrderExecutorV3Domain(ARBITRUM))
    expect(getCancelOrderDomain(ARBITRUM)).toEqual({ name: 'TeraSwapOrderExecutor', version: '3', chainId: ARBITRUM, verifyingContract: ARBITRUM_V3 })
    expect(() => getCancelOrderDomain(10)).toThrow('No OrderExecutor deployed on chain 10')
  })
})

describe('[third gate] Arbitrum One (42161) — v3-only: create, confirm, cancel all resolve to the DEPLOYMENTS.md V3', () => {
  it('the v2 nonce reads are fail-closed (disabled, no address) — the only place v2 is still consulted, and it is not a precondition', async () => {
    renderHook(() => useOrderEngine())
    const nonceReads = readContractCalls.filter(c => c.functionName === 'nonces' || c.functionName === 'invalidatedNonces')
    expect(nonceReads.length).toBeGreaterThan(0)
    for (const read of nonceReads) {
      expect(read.address).toBeUndefined()
      expect(read.enabled).toBe(false)
    }
  })

  it('create → confirm: signs under {TeraSwapOrderExecutor, "3", 42161, <Arbitrum V3>} with the v3 schema and POSTs chainId 42161 — no "not yet available" refusal', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig(ARBITRUM, { maxSlippageBps: 300 }))

    expect(mockSignTypedDataAsync).toHaveBeenCalledTimes(1)
    const typed = orderSign()
    expect(typed.domain).toEqual({ name: 'TeraSwapOrderExecutor', version: '3', chainId: ARBITRUM, verifyingContract: ARBITRUM_V3 })
    expect(typed.types.Order.some(f => f.name === 'maxSlippageBps' && f.type === 'uint16')).toBe(true)
    expect(typed.message.maxSlippageBps).toBe(300)
    expect(typed.message.owner).toBe(ADDRESS)

    expect(mockCreateOrderInSupabase).toHaveBeenCalledTimes(1)
    const posted = mockCreateOrderInSupabase.mock.calls[0][0] as { chainId: number; maxSlippageBps?: number; orderData: { maxSlippageBps?: number } }
    expect(posted.chainId).toBe(ARBITRUM)
    expect(posted.maxSlippageBps).toBe(300)
    expect(posted.orderData.maxSlippageBps).toBe(300)

    expect(result.current.latestEvent?.type).toBe('order_created')
    expect(result.current.orders[0]?.status).toBe('active')
  })

  it('create → confirm → cancel → confirmCancel: cancelOrder() goes to the SAME address the order was signed for, with the V3 ABI and the SAME struct (same EIP-712 digest), and the ownership proof is signed under the same v3 domain', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig(ARBITRUM, { maxSlippageBps: 300 }))
    const signed = orderSign()
    const order = result.current.orders[0]
    expect(order.status).toBe('active')

    await act(async () => { await result.current.cancelOrder(order.id) })
    expect(result.current.pendingCancel?.action).toBe('cancel')
    expect(mockWriteContractAsync).not.toHaveBeenCalled() // Phase A only freezes
    await act(async () => { await result.current.confirmCancel() })

    // On-chain: V3.cancelOrder(order) on the signing domain's verifyingContract, owner-only (V3.sol:636).
    expect(mockWriteContractAsync).toHaveBeenCalledTimes(1)
    const cancel = writeCalls()[0]
    expect(cancel.address).toBe(ARBITRUM_V3)
    expect(cancel.address).toBe(signed.domain.verifyingContract)
    expect(cancel.functionName).toBe('cancelOrder')
    expect(cancel.abi).toBe(ORDER_EXECUTOR_V3_ABI)
    // Same struct ⇒ same getOrderHash(order) (V3.sol:1149, pure over the fields) ⇒ the hash that
    // cancelledOrders[] marks is the one the :453 check reads before any fill. Proven the way the
    // contract does it: the EIP-712 digest over (domain, Order) is identical for what was signed and
    // for what is being cancelled.
    const cancelledStruct = cancel.args[0] as Record<string, unknown>
    const digestOf = (message: Record<string, unknown>) => hashTypedData({
      domain: signed.domain as Parameters<typeof hashTypedData>[0]['domain'],
      types: ORDER_V3_EIP712_TYPES,
      primaryType: 'Order',
      message: message as never,
    })
    expect(digestOf(cancelledStruct)).toBe(digestOf(signed.message))
    expect(cancelledStruct.maxSlippageBps).toBe(300)

    // Off-chain: the Supabase ownership proof, under getCancelOrderDomain(42161) = the v3 domain —
    // the same (chainId, verifyingContract, version) the order was signed under.
    const proofs = proofSigns()
    expect(proofs).toHaveLength(1)
    expect(proofs[0].domain).toEqual(signed.domain)
    expect(proofs[0].types).toBe(CANCEL_ORDER_TYPES)
    expect(proofs[0].message).toEqual({ id: ROW_ID, action: 'cancel' })
    expect(mockCancelOrderInSupabase).toHaveBeenCalledWith(ADDRESS, order.orderHash, expect.any(Function))

    expect(result.current.latestEvent).toEqual({ type: 'order_cancelled', orderId: order.id })
    expect(result.current.orders[0].status).toBe('cancelled')
  })

  it('cancelAllOrders on a stored v3 DCA: ONE cancelOrder() on the Arbitrum V3, no v2 invalidateNonces leg, proof under the v3 domain', async () => {
    mockFetchUserOrders.mockResolvedValue([makeV3Row(ARBITRUM)])
    const { result } = renderHook(() => useOrderEngine())
    await settleLoad()
    expect(result.current.orders).toHaveLength(1)

    await act(async () => { await result.current.cancelAllOrders() })
    expect(result.current.pendingCancel?.action).toBe('invalidate')
    if (result.current.pendingCancel?.action === 'invalidate') {
      expect(result.current.pendingCancel.newNonce).toBeNull()      // no v2 leg to send
      expect(result.current.pendingCancel.v3DcaOrders).toHaveLength(1)
    }
    await act(async () => { await result.current.confirmCancel() })

    const writes = writeCalls()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ address: ARBITRUM_V3, functionName: 'cancelOrder', abi: ORDER_EXECUTOR_V3_ABI })
    expect(writes.some(w => w.functionName === 'invalidateNonces')).toBe(false)
    expect(proofSigns().map(p => p.domain)).toEqual([getOrderExecutorV3Domain(ARBITRUM)])
    expect(result.current.latestEvent).toEqual({ type: 'order_cancelled', orderId: 'all' })
  })
})

describe('[third gate] Base (8453) — unchanged, pinned by literal address before and after', () => {
  beforeEach(() => { useChainIdMock.mockReturnValue(BASE) })

  it('v3 DCA: signs under {"3", 8453, <Base V3>}, cancels on <Base V3> with the V3 ABI, proves under the v2 domain of 0x135B…2598 — exactly as before this commit', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig(BASE, { maxSlippageBps: 300 }))
    const signed = orderSign()
    expect(signed.domain).toEqual({ name: 'TeraSwapOrderExecutor', version: '3', chainId: BASE, verifyingContract: BASE_V3 })
    expect(BASE_V3).toBe('0x686b4f812291F4De238E59ED00BA6dD6129e60a0') // the DEPLOYMENTS.md row, pinned

    const order = result.current.orders[0]
    await act(async () => { await result.current.cancelOrder(order.id) })
    await act(async () => { await result.current.confirmCancel() })

    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0]).toMatchObject({ address: BASE_V3, functionName: 'cancelOrder', abi: ORDER_EXECUTOR_V3_ABI })
    // The ownership proof stays namespaced under Base's v2 executor — the byte-identical
    // getOrderExecutorDomain(8453) every deployed client/server pair already agrees on.
    expect(proofSigns()).toHaveLength(1)
    expect(proofSigns()[0].domain).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: BASE, verifyingContract: BASE_V2 })
    expect(proofSigns()[0].domain).toEqual(getOrderExecutorDomain(BASE))
    expect(result.current.orders[0].status).toBe('cancelled')
  })

  it('v2 order (no maxSlippageBps): signs under {"2", 8453, 0x135B…2598}, cancels there with the v2 ABI, proves under the same v2 domain', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig(BASE))
    const signed = orderSign()
    expect(signed.domain).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: BASE, verifyingContract: BASE_V2 })
    expect(signed.message.maxSlippageBps).toBeUndefined()

    const order = result.current.orders[0]
    await act(async () => { await result.current.cancelOrder(order.id) })
    await act(async () => { await result.current.confirmCancel() })

    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0]).toMatchObject({ address: BASE_V2, functionName: 'cancelOrder', abi: ORDER_EXECUTOR_ABI })
    expect(proofSigns()[0].domain).toEqual(getOrderExecutorDomain(BASE))
  })

  it('cancelAllOrders on a stored v3 DCA: cancelOrder() on <Base V3>, no v2 leg (v2 exists but has nothing to cover), proof under the v2 domain', async () => {
    mockFetchUserOrders.mockResolvedValue([makeV3Row(BASE)])
    const { result } = renderHook(() => useOrderEngine())
    await settleLoad()
    await act(async () => { await result.current.cancelAllOrders() })
    await act(async () => { await result.current.confirmCancel() })

    expect(writeCalls()).toHaveLength(1)
    expect(writeCalls()[0]).toMatchObject({ address: BASE_V3, functionName: 'cancelOrder', abi: ORDER_EXECUTOR_V3_ABI })
    expect(proofSigns().map(p => p.domain)).toEqual([getOrderExecutorDomain(BASE)])
  })
})

describe('[third gate] Ethereum Mainnet (1) — v3 still refused, whatever the env slot says', () => {
  beforeEach(() => { useChainIdMock.mockReturnValue(MAINNET) })

  it('a config asking for v3 is signed as v2 against 0xeFC3…f130 (no maxSlippageBps in the message) — a v3 order cannot be minted on mainnet', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig(MAINNET, { maxSlippageBps: 300 }))
    const signed = orderSign()
    expect(signed.domain).toEqual({ name: 'TeraSwapOrderExecutor', version: '2', chainId: MAINNET, verifyingContract: MAINNET_V2 })
    expect('maxSlippageBps' in signed.message).toBe(false)
    const posted = mockCreateOrderInSupabase.mock.calls[0][0] as { chainId: number; maxSlippageBps?: number }
    expect(posted.chainId).toBe(MAINNET)
    expect(posted.maxSlippageBps).toBeUndefined()
  })

  it('a stored v3-tagged order on chain 1 cannot even be frozen for cancel — refused, no tx, no proof', async () => {
    mockFetchUserOrders.mockResolvedValue([makeV3Row(MAINNET)])
    const { result } = renderHook(() => useOrderEngine())
    await settleLoad()
    const order = result.current.orders[0]
    await act(async () => { await result.current.cancelOrder(order.id) })

    expect(result.current.pendingCancel).toBeNull()
    expect(result.current.latestEvent).toEqual({
      type: 'order_error', orderId: order.id,
      error: 'v3 conditional orders are not yet available on chain 1 — this order cannot be cancelled here.',
    })
    await act(async () => { await result.current.confirmCancel() }) // nothing frozen ⇒ no-op
    expect(mockWriteContractAsync).not.toHaveBeenCalled()
    expect(proofSigns()).toHaveLength(0)
  })

  it('a v2 order on mainnet: create/confirm/cancel are byte-identical — v2 domain, v2 executor, v2 ABI', async () => {
    const { result } = renderHook(() => useOrderEngine())
    await createAndConfirm(result, makeConfig(MAINNET, { orderType: OrderType.LIMIT, targetPrice: '3000', priceFeed: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', dcaInterval: 0, dcaTotal: 1 }))
    expect(orderSign().domain).toEqual(getOrderExecutorDomain(MAINNET))
    const order = result.current.orders[0]
    await act(async () => { await result.current.cancelOrder(order.id) })
    await act(async () => { await result.current.confirmCancel() })
    expect(writeCalls()[0]).toMatchObject({ address: MAINNET_V2, functionName: 'cancelOrder', abi: ORDER_EXECUTOR_ABI })
    expect(proofSigns()[0].domain).toEqual(getOrderExecutorDomain(MAINNET))
  })
})
