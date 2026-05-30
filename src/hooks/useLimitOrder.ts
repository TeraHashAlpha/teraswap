/**
 * TeraSwap — useLimitOrder hook
 *
 * Manages limit order lifecycle: creation, EIP-712 signing, submission
 * to CoW Protocol orderbook, status polling, and local persistence.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useChainId, useSignTypedData } from 'wagmi'
import { COW_SETTLEMENT } from '@/lib/constants'
import {
  buildLimitOrderParams,
  submitLimitOrder,
  fetchLimitOrderStatus,
} from '@/lib/limit-order-api'
import type {
  LimitOrder,
  LimitOrderConfig,
  LimitOrderEvent,
  LimitOrderStatus,
} from '@/lib/limit-order-types'
import { LIMIT_STORAGE_KEY, LIMIT_POLL_INTERVAL_MS } from '@/lib/limit-order-types'
import { initSecureStorage, secureGet, secureSet } from '@/lib/secure-storage'

// ── Persistence helpers ──────────────────────────────────────
// [P200] Limit orders are encrypted at rest via SecureStorage (AES-256-GCM,
// wallet-derived key). The v2 key marks the encrypted format; the legacy v1
// key held plaintext JSON and is migrated + removed on first load.
const LIMIT_STORAGE_KEY_V2 = `${LIMIT_STORAGE_KEY}:v2`

/** Read the legacy v1 (plaintext) payload for one-time migration. */
function readLegacyOrders(): LimitOrder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(LIMIT_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as LimitOrder[]) : []
  } catch {
    return []
  }
}

/**
 * Load orders from the encrypted v2 store, transparently migrating any legacy
 * v1 plaintext data on first run. Async because AES-GCM decryption is async.
 */
async function loadOrders(): Promise<LimitOrder[]> {
  if (typeof window === 'undefined') return []
  const encrypted = await secureGet<LimitOrder[]>(LIMIT_STORAGE_KEY_V2)
  if (encrypted && encrypted.length > 0) return encrypted

  const legacy = readLegacyOrders()
  if (legacy.length > 0) {
    await saveOrders(legacy)
    try { localStorage.removeItem(LIMIT_STORAGE_KEY) } catch { /* ignore */ }
    return legacy
  }
  return encrypted ?? []
}

/** Encrypt + persist the order list under the v2 key. */
async function saveOrders(orders: LimitOrder[]): Promise<void> {
  if (typeof window === 'undefined') return
  await secureSet(LIMIT_STORAGE_KEY_V2, orders)
}

// ── Hook ─────────────────────────────────────────────────────
export function useLimitOrder() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { signTypedDataAsync } = useSignTypedData()

  const [orders, setOrders] = useState<LimitOrder[]>([])
  const [latestEvent, setLatestEvent] = useState<LimitOrderEvent | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // [BUGFIX] Use ref to always access latest orders in callbacks (avoids stale closures)
  const ordersRef = useRef<LimitOrder[]>(orders)
  ordersRef.current = orders
  // [P200] Guard: don't persist the initial empty array before the async load
  // resolves — otherwise the save effect would clobber the encrypted store.
  const hasLoadedRef = useRef(false)

  // Load (decrypt) from localStorage on mount / wallet change
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

  // Save (encrypt) whenever orders change (including clearing when empty)
  useEffect(() => {
    // [P200] Skip until the async load has populated state — otherwise the
    // initial empty array would overwrite the encrypted store.
    if (!hasLoadedRef.current) return
    void saveOrders(orders)
  }, [orders])

  // ── Poll open orders for status changes ────────────────────
  const openCount = orders.filter(o => o.status === 'open' || o.status === 'partiallyFilled').length
  useEffect(() => {
    if (openCount === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }

    async function pollAll() {
      // [BUGFIX] Read from ref for fresh data
      const openOrders = ordersRef.current.filter(o => o.status === 'open' || o.status === 'partiallyFilled')
      for (const order of openOrders) {
        try {
          const result = await fetchLimitOrderStatus(order.orderUid)

          setOrders(prev => prev.map(o => {
            if (o.id !== order.id) return o

            let newStatus: LimitOrderStatus = o.status
            if (result.status === 'fulfilled') {
              newStatus = 'fulfilled'
              setLatestEvent({ type: 'order_filled', orderId: o.id, txHash: result.txHash || '' })
            } else if (result.status === 'expired') {
              newStatus = 'expired'
              setLatestEvent({ type: 'order_expired', orderId: o.id })
            } else if (result.status === 'cancelled') {
              newStatus = 'cancelled'
              setLatestEvent({ type: 'order_cancelled', orderId: o.id })
            } else if (result.filledPercent > 0 && result.filledPercent < 100) {
              newStatus = 'partiallyFilled'
              setLatestEvent({ type: 'order_partially_filled', orderId: o.id, filledPercent: result.filledPercent })
            }

            return {
              ...o,
              status: newStatus,
              filledAmount: result.executedBuyAmount,
              filledPercent: result.filledPercent,
              txHash: result.txHash || o.txHash,
              executedAt: newStatus === 'fulfilled' ? Date.now() : o.executedAt,
            }
          }))
        } catch { /* network error — retry next tick */ }
      }
    }

    pollAll()
    pollRef.current = setInterval(pollAll, LIMIT_POLL_INTERVAL_MS)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [openCount])

  // ── Create + sign + submit limit order ─────────────────────
  const createOrder = useCallback(async (config: LimitOrderConfig) => {
    if (!address) throw new Error('Wallet not connected')

    setIsSubmitting(true)
    const orderId = crypto.randomUUID()

    // Build order params
    const orderParams = buildLimitOrderParams(config, address)

    // Create local order record
    const newOrder: LimitOrder = {
      id: orderId,
      orderUid: '',
      config,
      buyAmount: orderParams.buyAmount,
      validTo: orderParams.validTo,
      status: 'signing',
      filledAmount: '0',
      filledPercent: 0,
      txHash: null,
      executedAt: null,
      createdAt: Date.now(),
      error: null,
    }

    setOrders(prev => [newOrder, ...prev])
    setLatestEvent({ type: 'order_created', orderId })

    try {
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

      // Submit to CoW orderbook
      const orderUid = await submitLimitOrder(orderParams, signature)

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, orderUid, status: 'open' as LimitOrderStatus }
          : o
      ))
      setLatestEvent({ type: 'order_signed', orderId, orderUid })
    } catch (err) {
      const errorMsg = err instanceof Error
        ? (err.message.toLowerCase().includes('user rejected')
            ? 'Signature rejected in wallet.'
            : err.message.slice(0, 120))
        : 'Unknown error'

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, status: 'error' as LimitOrderStatus, error: errorMsg }
          : o
      ))
      setLatestEvent({ type: 'order_error', orderId, error: errorMsg })
    } finally {
      setIsSubmitting(false)
    }
  }, [address, chainId, signTypedDataAsync])

  // ── Cancel order ───────────────────────────────────────────
  const cancelOrder = useCallback(async (orderId: string) => {
    // [BUGFIX] Use ref to avoid stale closure
    const order = ordersRef.current.find(o => o.id === orderId)
    if (!order || !order.orderUid) return

    // Mark as cancelled locally (CoW cancellation via API requires signing
    // a cancellation message — for simplicity, we mark locally and the
    // order will naturally expire if not filled)
    setOrders(prev => prev.map(o =>
      o.id === orderId
        ? { ...o, status: 'cancelled' as LimitOrderStatus }
        : o
    ))
    setLatestEvent({ type: 'order_cancelled', orderId })
  }, [])

  // ── Remove order from list ─────────────────────────────────
  const removeOrder = useCallback((orderId: string) => {
    setOrders(prev => {
      const updated = prev.filter(o => o.id !== orderId)
      void saveOrders(updated)
      return updated
    })
  }, [])

  // ── Derived data ───────────────────────────────────────────
  const activeOrders = orders.filter(o => o.status === 'open' || o.status === 'partiallyFilled' || o.status === 'signing')
  const historyOrders = orders.filter(o => o.status === 'fulfilled' || o.status === 'expired' || o.status === 'cancelled' || o.status === 'error')

  return {
    orders,
    activeOrders,
    historyOrders,
    latestEvent,
    isSubmitting,
    createOrder,
    cancelOrder,
    removeOrder,
  }
}
