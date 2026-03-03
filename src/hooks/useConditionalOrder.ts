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

// ── Persistence ─────────────────────────────────────────────
function loadOrders(): ConditionalOrder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(CONDITIONAL_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveOrders(orders: ConditionalOrder[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(CONDITIONAL_STORAGE_KEY, JSON.stringify(orders))
  } catch { /* silent */ }
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

  // Load on mount
  useEffect(() => {
    setOrders(loadOrders())
  }, [])

  // Save on change
  useEffect(() => {
    if (orders.length > 0) saveOrders(orders)
  }, [orders])

  // ── Price monitoring for 'monitoring' orders ──────────────
  useEffect(() => {
    const monitoringOrders = orders.filter(o => o.status === 'monitoring')
    if (monitoringOrders.length === 0) {
      if (pricePollRef.current) { clearInterval(pricePollRef.current); pricePollRef.current = null }
      return
    }

    async function pollPrices() {
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
  }, [orders.filter(o => o.status === 'monitoring').length])

  // ── Poll submitted CoW orders for fill status ─────────────
  useEffect(() => {
    const submittedOrders = orders.filter(o =>
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
  }, [orders.filter(o => o.status === 'submitted' || o.status === 'partiallyFilled').length])

  // ── Handle trigger: sign + submit CoW order ───────────────
  const handleTrigger = useCallback(async (orderId: string) => {
    const order = orders.find(o => o.id === orderId)
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
  }, [orders, address, chainId, signTypedDataAsync])

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
      saveOrders(updated)
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
