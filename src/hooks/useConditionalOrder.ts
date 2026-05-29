/**
 * TeraSwap — useConditionalOrder hook
 *
 * Manages Stop Loss & Take Profit orders:
 * 1. User sets a trigger price (USD) and a limit order config
 * 2. Hook polls Chainlink for current price every 5s
 * 3. When trigger fires, auto-submits a CoW Protocol limit order
 * 4. Then polls CoW for fill status like regular limit orders
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useChainId, useSignTypedData } from 'wagmi'
import { COW_SETTLEMENT } from '@/lib/constants'
import {
  buildLimitOrderParams,
  submitLimitOrder,
  fetchLimitOrderStatus,
} from '@/lib/limit-order-api'
import { getTokenPriceUSD, isTriggerMet } from '@/lib/price-monitor'
import type {
  ConditionalOrder,
  ConditionalOrderConfig,
  ConditionalOrderEvent,
  ConditionalOrderStatus,
} from '@/lib/conditional-order-types'
import {
  CONDITIONAL_STORAGE_KEY,
  PRICE_POLL_INTERVAL_MS,
  ORDER_POLL_INTERVAL_MS,
} from '@/lib/conditional-order-types'
import { initSecureStorage, secureGet, secureSet } from '@/lib/secure-storage'

// ── Persistence ─────────────────────────────────────────────
// [P200] Conditional orders are encrypted at rest via SecureStorage
// (AES-256-GCM, wallet-derived key). The v2 key marks the encrypted format;
// the legacy v1 key held plaintext JSON and is migrated + removed on first load.
const CONDITIONAL_STORAGE_KEY_V2 = `${CONDITIONAL_STORAGE_KEY}:v2`

/** Read the legacy v1 (plaintext) payload for one-time migration. */
function readLegacyOrders(): ConditionalOrder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(CONDITIONAL_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as ConditionalOrder[]) : []
  } catch {
    return []
  }
}

/**
 * Load orders from the encrypted v2 store, transparently migrating any legacy
 * v1 plaintext data on first run. Async because AES-GCM decryption is async.
 */
async function loadOrders(): Promise<ConditionalOrder[]> {
  if (typeof window === 'undefined') return []
  const encrypted = await secureGet<ConditionalOrder[]>(CONDITIONAL_STORAGE_KEY_V2)
  if (encrypted && encrypted.length > 0) return encrypted

  const legacy = readLegacyOrders()
  if (legacy.length > 0) {
    await saveOrders(legacy)
    try { localStorage.removeItem(CONDITIONAL_STORAGE_KEY) } catch { /* ignore */ }
    return legacy
  }
  return encrypted ?? []
}

/** Encrypt + persist the order list under the v2 key. */
async function saveOrders(orders: ConditionalOrder[]): Promise<void> {
  if (typeof window === 'undefined') return
  await secureSet(CONDITIONAL_STORAGE_KEY_V2, orders)
}

// ── Hook ────────────────────────────────────────────────────
export function useConditionalOrder() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { signTypedDataAsync } = useSignTypedData()

  const [orders, setOrders] = useState<ConditionalOrder[]>([])
  const [latestEvent, setLatestEvent] = useState<ConditionalOrderEvent | null>(null)
  const pricePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const orderPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const triggeringRef = useRef<Set<string>>(new Set()) // prevent double triggers
  // [BUGFIX] Use ref to always access latest orders in callbacks (avoids stale closures)
  const ordersRef = useRef<ConditionalOrder[]>(orders)
  ordersRef.current = orders
  // [P200] Guard: don't persist the initial empty array before the async load
  // resolves — otherwise the save effect would clobber the encrypted store.
  const hasLoadedRef = useRef(false)

  // Load (decrypt) on mount / wallet change
  useEffect(() => {
    hasLoadedRef.current = false

    if (!address) {
      setOrders([])
      return
    }

    // Derive this wallet's AES-GCM key before any secure read/write.
    initSecureStorage(address)

    let cancelled = false
    void (async () => {
      const local = await loadOrders()
      if (cancelled) return
      setOrders(prev => {
        if (prev.length === 0) return local
        const seen = new Set(prev.map(o => o.id))
        return [...prev, ...local.filter(o => !seen.has(o.id))]
      })
      hasLoadedRef.current = true
    })()

    return () => { cancelled = true }
  }, [address])

  // Save (encrypt) on change (including clearing when empty)
  useEffect(() => {
    // [P200] Skip until the async load has populated state — otherwise the
    // initial empty array would overwrite the encrypted store.
    if (!hasLoadedRef.current) return
    void saveOrders(orders)
  }, [orders])

  // ── Price monitoring for 'monitoring' orders ──────────────
  const monitoringCount = orders.filter(o => o.status === 'monitoring').length
  useEffect(() => {
    if (monitoringCount === 0) {
      if (pricePollRef.current) { clearInterval(pricePollRef.current); pricePollRef.current = null }
      return
    }

    async function pollPrices() {
      // [BUGFIX] Read from ref to avoid stale closure
      const monitoringOrders = ordersRef.current.filter(o => o.status === 'monitoring')
      if (monitoringOrders.length === 0) return
      // Get unique token addresses to poll
      const tokenAddresses = [...new Set(monitoringOrders.map(o => o.monitorTokenAddress))]

      // Fetch prices in parallel
      const priceMap = new Map<string, number>()
      await Promise.all(
        tokenAddresses.map(async (addr) => {
          const price = await getTokenPriceUSD(addr)
          if (price > 0) priceMap.set(addr, price)
        })
      )

      setOrders(prev => prev.map(o => {
        if (o.status !== 'monitoring') return o
        const currentPrice = priceMap.get(o.monitorTokenAddress) || o.currentPrice

        // Check trigger
        const triggered = isTriggerMet(currentPrice, o.triggerPrice, o.config.triggerDirection)

        if (triggered && !triggeringRef.current.has(o.id)) {
          triggeringRef.current.add(o.id)
          setLatestEvent({ type: 'price_triggered', orderId: o.id, price: currentPrice })
          // Trigger the CoW order submission (async, handled separately)
          handleTrigger(o.id)
          return { ...o, currentPrice, status: 'triggered' as ConditionalOrderStatus }
        }

        return { ...o, currentPrice }
      }))
    }

    pollPrices()
    pricePollRef.current = setInterval(pollPrices, PRICE_POLL_INTERVAL_MS)
    return () => { if (pricePollRef.current) clearInterval(pricePollRef.current) }
  }, [monitoringCount])

  // ── Poll submitted CoW orders for fill status ─────────────
  const submittedCount = orders.filter(o =>
    (o.status === 'submitted' || o.status === 'partiallyFilled') && o.orderUid
  ).length
  useEffect(() => {
    // [BUGFIX] Read from ref for fresh data
    const submittedOrders = ordersRef.current.filter(o =>
      (o.status === 'submitted' || o.status === 'partiallyFilled') && o.orderUid
    )
    if (submittedOrders.length === 0) {
      if (orderPollRef.current) { clearInterval(orderPollRef.current); orderPollRef.current = null }
      return
    }

    async function pollOrders() {
      for (const order of submittedOrders) {
        if (!order.orderUid) continue
        try {
          const result = await fetchLimitOrderStatus(order.orderUid)

          setOrders(prev => prev.map(o => {
            if (o.id !== order.id) return o

            let newStatus: ConditionalOrderStatus = o.status
            if (result.status === 'fulfilled') {
              newStatus = 'filled'
              setLatestEvent({ type: 'order_filled', orderId: o.id, txHash: result.txHash || '' })
            } else if (result.status === 'expired') {
              newStatus = 'expired'
              setLatestEvent({ type: 'order_expired', orderId: o.id })
            } else if (result.status === 'cancelled') {
              newStatus = 'cancelled'
              setLatestEvent({ type: 'order_cancelled', orderId: o.id })
            } else if (result.filledPercent > 0 && result.filledPercent < 100) {
              newStatus = 'partiallyFilled'
            }

            return {
              ...o,
              status: newStatus,
              filledPercent: result.filledPercent,
              txHash: result.txHash || o.txHash,
              executedAt: newStatus === 'filled' ? Date.now() : o.executedAt,
            }
          }))
        } catch { /* retry next tick */ }
      }
    }

    pollOrders()
    orderPollRef.current = setInterval(pollOrders, ORDER_POLL_INTERVAL_MS)
    return () => { if (orderPollRef.current) clearInterval(orderPollRef.current) }
  }, [submittedCount])

  // ── Handle trigger: sign + submit CoW order ───────────────
  const handleTrigger = useCallback(async (orderId: string) => {
    // [BUGFIX] Use ref to avoid stale closure over orders array
    const order = ordersRef.current.find(o => o.id === orderId)
    if (!order || !address) return

    try {
      const { config } = order
      const limitConfig = {
        tokenIn: config.tokenIn,
        tokenOut: config.tokenOut,
        sellAmount: config.sellAmount,
        targetPrice: config.limitPrice,
        kind: 'sell' as const,
        expirySeconds: config.expirySeconds,
        partiallyFillable: config.partiallyFillable,
        slippage: 0,
      }

      const orderParams = buildLimitOrderParams(limitConfig, address)

      // EIP-712 signing
      const domain = {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId,
        verifyingContract: COW_SETTLEMENT as `0x${string}`,
      } as const

      const types = {
        Order: [
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'buyAmount', type: 'uint256' },
          { name: 'validTo', type: 'uint32' },
          { name: 'appData', type: 'bytes32' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'kind', type: 'string' },
          { name: 'partiallyFillable', type: 'bool' },
          { name: 'sellTokenBalance', type: 'string' },
          { name: 'buyTokenBalance', type: 'string' },
        ],
      } as const

      const message = {
        sellToken: orderParams.sellToken as `0x${string}`,
        buyToken: orderParams.buyToken as `0x${string}`,
        receiver: address as `0x${string}`,
        sellAmount: BigInt(orderParams.sellAmount),
        buyAmount: BigInt(orderParams.buyAmount),
        validTo: orderParams.validTo,
        appData: orderParams.appDataHash as `0x${string}`,
        feeAmount: BigInt(orderParams.feeAmount),
        kind: orderParams.kind,
        partiallyFillable: orderParams.partiallyFillable,
        sellTokenBalance: orderParams.sellTokenBalance,
        buyTokenBalance: orderParams.buyTokenBalance,
      }

      const signature = await signTypedDataAsync({
        domain,
        types,
        primaryType: 'Order',
        message,
      })

      const orderUid = await submitLimitOrder(orderParams, signature)

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, orderUid, status: 'submitted' as ConditionalOrderStatus }
          : o
      ))
      setLatestEvent({ type: 'order_submitted', orderId, orderUid })
    } catch (err) {
      const errorMsg = err instanceof Error
        ? (err.message.toLowerCase().includes('user rejected')
            ? 'Signature rejected — order not placed.'
            : err.message.slice(0, 120))
        : 'Unknown error'

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, status: 'error' as ConditionalOrderStatus, error: errorMsg }
          : o
      ))
      setLatestEvent({ type: 'order_error', orderId, error: errorMsg })
    } finally {
      triggeringRef.current.delete(orderId)
    }
  }, [address, chainId, signTypedDataAsync])

  // ── Create conditional order ──────────────────────────────
  const createOrder = useCallback(async (config: ConditionalOrderConfig) => {
    if (!address) throw new Error('Wallet not connected')

    const orderId = crypto.randomUUID()

    // Get initial price
    const currentPrice = await getTokenPriceUSD(config.tokenIn.address)

    const newOrder: ConditionalOrder = {
      id: orderId,
      config,
      monitorTokenAddress: config.tokenIn.address,
      currentPrice,
      triggerPrice: config.triggerPrice,
      status: 'monitoring',
      orderUid: null,
      filledPercent: 0,
      txHash: null,
      executedAt: null,
      createdAt: Date.now(),
      error: null,
    }

    setOrders(prev => [newOrder, ...prev])
    setLatestEvent({ type: 'order_created', orderId })
  }, [address])

  // ── Cancel order ──────────────────────────────────────────
  const cancelOrder = useCallback((orderId: string) => {
    setOrders(prev => prev.map(o =>
      o.id === orderId
        ? { ...o, status: 'cancelled' as ConditionalOrderStatus }
        : o
    ))
    setLatestEvent({ type: 'order_cancelled', orderId })
  }, [])

  // ── Remove order from list ────────────────────────────────
  const removeOrder = useCallback((orderId: string) => {
    setOrders(prev => {
      const updated = prev.filter(o => o.id !== orderId)
      void saveOrders(updated)
      return updated
    })
  }, [])

  // ── Derived ───────────────────────────────────────────────
  const activeOrders = orders.filter(o =>
    o.status === 'monitoring' || o.status === 'triggered' || o.status === 'submitted' || o.status === 'partiallyFilled'
  )
  const historyOrders = orders.filter(o =>
    o.status === 'filled' || o.status === 'expired' || o.status === 'cancelled' || o.status === 'error'
  )

  return {
    orders,
    activeOrders,
    historyOrders,
    latestEvent,
    createOrder,
    cancelOrder,
    removeOrder,
  }
}
