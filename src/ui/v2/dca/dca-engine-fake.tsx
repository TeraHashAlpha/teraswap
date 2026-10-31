/**
 * [B6b] A stateful stand-in for v1's `useOrderEngine` with v1's OBSERVABLE contract — the two-phase gates (`createOrder` freezes a
 * `pendingOrder`, `confirmOrder` consumes it, flips `isSubmitting`, settles with ONE `order_created` / `order_error` event; `cancelOrder`
 * freezes a `pendingCancel`, `confirmCancel` consumes it) — so v1's DCAPanel and the v2 card can be driven end to end on the SAME
 * engine and what each handed it (arguments, order, count) compared. Nothing here signs, fetches or touches a wallet: the outcome of
 * each "signature" is scripted by the test (`fake.sign`), and a POST is recorded only when the script says the signature succeeded.
 *
 * Not a test file — `vi.mock('@/hooks/useOrderEngine', …)` lives in each test and points at `useFakeOrderEngine`.
 */
import { useCallback, useState } from 'react'
import type { PendingCancelReview, PendingOrderReview } from '@/hooks/useOrderEngine'
import type { AutonomousOrder, CreateOrderConfig, OnChainOrder, OrderEngineEvent } from '@/lib/order-engine'

export type SignOutcome = { event: OrderEngineEvent; posted: boolean }

export const fake = {
  chainId: 8453,
  account: '0xd44d00000000000000000000000000000000962d' as `0x${string}`,
  /** Every engine call a tree made, in order, with its arguments. */
  seq: [] as Array<[string, ...unknown[]]>,
  /** What the wallet "answers" when `confirmOrder` asks for the signature — scripted per test (default: signed, stored). */
  sign: (async (): Promise<SignOutcome> => ({ event: { type: 'order_created', orderId: 'o1', orderHash: '0xhash' }, posted: true })) as () => Promise<SignOutcome>,
  /** What `confirmCancel` settles with (default: cancelled on-chain). */
  cancelOutcome: (async (orderId: string): Promise<OrderEngineEvent> => ({ type: 'order_cancelled', orderId })) as (orderId: string) => Promise<OrderEngineEvent>,
  /** The bodies that reached "/api/orders" (only after a successful signature — a rejection never POSTs, as in v1). */
  posts: [] as unknown[],
  /** The stored orders the trees list (`dcaOrders`). */
  orders: [] as AutonomousOrder[],
  /** [B7] The engine's first-load flag and the W6-M-01 read-signature denial, as the Orders test wants them. */
  isLoading: false,
  readAuthDenied: false,
}

export function resetFake() {
  fake.seq = []
  fake.posts = []
  fake.orders = []
  fake.isLoading = false
  fake.readAuthDenied = false
  fake.sign = async () => ({ event: { type: 'order_created', orderId: 'o1', orderHash: '0xhash' }, posted: true })
  fake.cancelOutcome = async (orderId) => ({ type: 'order_cancelled', orderId })
}

/** A test-controlled promise: the tree sits in `signing` until the test settles it. */
export function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

/** v1's createOrder struct build, shape for shape (display only here — the sheet renders from it). */
function freeze(config: CreateOrderConfig): PendingOrderReview {
  const order: OnChainOrder = {
    owner: fake.account,
    tokenIn: config.tokenIn.address as `0x${string}`,
    tokenOut: config.tokenOut.address as `0x${string}`,
    amountIn: BigInt(config.amountIn),
    minAmountOut: BigInt(config.minAmountOut),
    ...(config.maxSlippageBps !== undefined ? { maxSlippageBps: config.maxSlippageBps } : {}),
    orderType: config.orderType,
    condition: config.condition,
    targetPrice: BigInt(config.targetPrice),
    priceFeed: config.priceFeed as `0x${string}`,
    expiry: BigInt(Math.floor(Date.now() / 1000) + config.expirySeconds),
    nonce: 7n,
    router: config.router as `0x${string}`,
    routerDataHash: ZERO_HASH,
    dcaInterval: BigInt(config.dcaInterval ?? 0),
    dcaTotal: BigInt(config.dcaTotal ?? 1),
  }
  return { order, config, computedHash: `0x${'ab'.repeat(32)}` as `0x${string}`, chainId: fake.chainId, account: fake.account }
}

export function useFakeOrderEngine() {
  const [pendingOrder, setPendingOrder] = useState<PendingOrderReview | null>(null)
  const [pendingCancel, setPendingCancel] = useState<PendingCancelReview | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [latestEvent, setLatestEvent] = useState<OrderEngineEvent | null>(null)
  const [orders, setOrders] = useState<AutonomousOrder[]>(fake.orders)

  const createOrder = useCallback(async (config: CreateOrderConfig) => {
    fake.seq.push(['createOrder', config])
    setPendingOrder(freeze(config))
  }, [])

  const confirmOrder = useCallback(async () => {
    if (!pendingOrder) return
    fake.seq.push(['confirmOrder'])
    setPendingOrder(null)
    setIsSubmitting(true)
    const { event, posted } = await fake.sign()
    if (posted) fake.posts.push({ orderHash: pendingOrder.computedHash, floorAck: pendingOrder.config.floorAck })
    setIsSubmitting(false)
    setLatestEvent(event)
  }, [pendingOrder])

  const clearPendingOrder = useCallback(() => {
    fake.seq.push(['clearPendingOrder'])
    setPendingOrder(null)
  }, [])

  const cancelOrder = useCallback(async (orderId: string) => {
    fake.seq.push(['cancelOrder', orderId])
    const order = orders.find((o) => o.id === orderId)
    if (!order) return
    const o = order.order
    const orderStruct = {
      owner: o.owner, tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: BigInt(o.amountIn.toString()), minAmountOut: BigInt((o.minAmountOut ?? 1n).toString()),
      orderType: Number(o.orderType ?? 2), condition: Number(o.condition ?? 0), targetPrice: BigInt((o.targetPrice ?? 0n).toString()), priceFeed: o.priceFeed ?? '0x0000000000000000000000000000000000000000',
      expiry: BigInt((o.expiry ?? 0n).toString()), nonce: BigInt((o.nonce ?? 0n).toString()), router: o.router ?? '0x1111111111111111111111111111111111111111', routerDataHash: ZERO_HASH,
      dcaInterval: BigInt(o.dcaInterval.toString()), dcaTotal: BigInt((o.dcaTotal ?? 1n).toString()),
    } as OnChainOrder
    setPendingCancel({ action: 'cancel', orderId, order, orderStruct, isV3: o.maxSlippageBps !== undefined, chainId: fake.chainId, account: fake.account })
  }, [orders])

  const cancelAllOrders = useCallback(async () => {
    fake.seq.push(['cancelAllOrders'])
    const active = orders.filter((o) => o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled')
    setPendingCancel({ action: 'invalidate', newNonce: null, v2AffectedOrders: [], v3Batches: [], v3DcaOrders: active.map((order) => ({ order, orderStruct: {} as OnChainOrder })), affectedOrders: active, skippedOrders: [], chainId: fake.chainId, account: fake.account })
  }, [orders])

  const confirmCancel = useCallback(async () => {
    if (!pendingCancel) return
    fake.seq.push(['confirmCancel'])
    setPendingCancel(null)
    const ids = pendingCancel.action === 'cancel' ? [pendingCancel.orderId] : pendingCancel.affectedOrders.map((o) => o.id)
    const event = await fake.cancelOutcome(ids[0] ?? 'all')
    if (event.type === 'order_cancelled') setOrders((prev) => prev.map((o) => (ids.includes(o.id) ? { ...o, status: 'cancelled' as const } : o)))
    setLatestEvent(event)
  }, [pendingCancel])

  const clearPendingCancel = useCallback(() => {
    fake.seq.push(['clearPendingCancel'])
    setPendingCancel(null)
  }, [])

  const removeOrder = useCallback((orderId: string) => {
    fake.seq.push(['removeOrder', orderId])
    setOrders((prev) => prev.filter((o) => o.id !== orderId))
  }, [])

  const requestOrdersReadAuth = useCallback(async () => {
    fake.seq.push(['requestOrdersReadAuth'])
  }, [])

  // [B7] v1's derived lists (useOrderEngine.ts:1342-1350), so the Orders tab sees what v1's OrderDashboard sees.
  const activeOrders = orders.filter((o) => o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled' || o.status === 'signing')
  const historyOrders = orders.filter((o) => o.status === 'filled' || o.status === 'expired' || o.status === 'cancelled' || o.status === 'error')
  const dcaOrders = orders
  return {
    orders, activeOrders, historyOrders, limitOrders: [], stopLossOrders: [], dcaOrders,
    latestEvent, isSubmitting, isLoading: fake.isLoading, readAuthDenied: fake.readAuthDenied, requestOrdersReadAuth, currentNonce: 0n,
    createOrder, pendingOrder, confirmOrder, clearPendingOrder, pendingCancel, confirmCancel, clearPendingCancel, cancelOrder, cancelAllOrders, removeOrder,
  }
}
