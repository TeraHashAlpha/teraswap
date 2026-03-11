/**
 * TeraSwap — useOrderEngine hook
 *
 * Manages the full lifecycle of autonomous orders:
 * 1. Build order struct from UI config
 * 2. Sign via EIP-712 (wagmi signTypedData)
 * 3. Submit to Supabase (executor picks it up)
 * 4. Poll for status changes + real-time subscription
 * 5. Cancel on-chain + in Supabase
 *
 * Works for all order types: Limit, Stop-Loss, DCA.
 */

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useChainId, useSignTypedData, useReadContract, useWriteContract } from 'wagmi'
import { keccak256, encodeAbiParameters, toBytes } from 'viem'
import {
  ORDER_EXECUTOR_ABI,
  ORDER_EXECUTOR_ADDRESS,
  ORDER_EIP712_TYPES,
  OrderType,
  PriceCondition,
  ORDER_POLL_INTERVAL_MS,
  createOrderInSupabase,
  fetchUserOrders,
  fetchActiveOrders,
  cancelOrderInSupabase,
  subscribeToOrders,
} from '@/lib/order-engine'
import type {
  OnChainOrder,
  AutonomousOrder,
  AutonomousOrderStatus,
  CreateOrderConfig,
  OrderEngineEvent,
  OrderRow,
} from '@/lib/order-engine'

// ── Order hash computation (matches contract's getOrderHash) ──
const ORDER_TYPEHASH = keccak256(toBytes(
  'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint8 orderType,uint8 condition,uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'
))

const ORDER_HASH_PARAMS = [
  { type: 'bytes32' as const },
  { type: 'address' as const },
  { type: 'address' as const },
  { type: 'address' as const },
  { type: 'uint256' as const },
  { type: 'uint256' as const },
  { type: 'uint8' as const },
  { type: 'uint8' as const },
  { type: 'uint256' as const },
  { type: 'address' as const },
  { type: 'uint256' as const },
  { type: 'uint256' as const },
  { type: 'address' as const },
  { type: 'bytes32' as const },  // routerDataHash [C-01]
  { type: 'uint256' as const },
  { type: 'uint256' as const },
]

/** Pure client-side computation — no RPC call needed */
function computeOrderHash(order: OnChainOrder): `0x${string}` {
  return keccak256(encodeAbiParameters(ORDER_HASH_PARAMS, [
    ORDER_TYPEHASH,
    order.owner,
    order.tokenIn,
    order.tokenOut,
    BigInt(order.amountIn.toString()),
    BigInt(order.minAmountOut.toString()),
    Number(order.orderType),
    Number(order.condition),
    BigInt(order.targetPrice.toString()),
    order.priceFeed,
    BigInt(order.expiry.toString()),
    BigInt(order.nonce.toString()),
    order.router,
    order.routerDataHash,  // [C-01]
    BigInt(order.dcaInterval.toString()),
    BigInt(order.dcaTotal.toString()),
  ]))
}

// ── Storage key ──────────────────────────────────────────
const STORAGE_KEY = 'teraswap_orders_v3'

// [N-04/F-02] Obfuscate sensitive data in localStorage (signatures, order hashes)
// Uses a simple XOR-based encoding to prevent trivial scraping by browser extensions.
// Not cryptographic — defense-in-depth layer. True encryption needs a user-derived key.
const OBFUSCATION_KEY = 'TeraSwap_2026_v3'

function obfuscate(data: string): string {
  const key = OBFUSCATION_KEY
  let result = ''
  for (let i = 0; i < data.length; i++) {
    result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length))
  }
  return btoa(result) // base64 to keep it safe in localStorage
}

function deobfuscate(encoded: string): string {
  try {
    const data = atob(encoded)
    const key = OBFUSCATION_KEY
    let result = ''
    for (let i = 0; i < data.length; i++) {
      result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length))
    }
    return result
  } catch { return '' }
}

function loadOrders(): AutonomousOrder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    // Try deobfuscated first (new format), fall back to plain JSON (migration)
    try {
      const decoded = deobfuscate(raw)
      return JSON.parse(decoded)
    } catch {
      // Fallback: old unencrypted format
      return JSON.parse(raw)
    }
  } catch { return [] }
}

function saveOrders(orders: AutonomousOrder[]) {
  if (typeof window === 'undefined') return
  try {
    const json = JSON.stringify(orders, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    )
    localStorage.setItem(STORAGE_KEY, obfuscate(json))
  } catch { /* quota exceeded */ }
  // Clean up old unencrypted key
  try { localStorage.removeItem('teraswap_orders_v2') } catch {}
}

// ── Convert Supabase row → UI order ──────────────────────
function rowToOrder(row: OrderRow): AutonomousOrder {
  const typeMap: Record<string, OrderType> = {
    limit: OrderType.LIMIT,
    stop_loss: OrderType.STOP_LOSS,
    dca: OrderType.DCA,
  }

  return {
    id: row.id,
    orderHash: row.order_hash,
    order: row.order_data as unknown as OnChainOrder,
    signature: row.signature,
    status: row.status as AutonomousOrderStatus,
    orderType: typeMap[row.order_type] ?? OrderType.LIMIT,
    tokenInSymbol: '', // Will be enriched by UI
    tokenInDecimals: 18,
    tokenOutSymbol: '',
    tokenOutDecimals: 18,
    dcaExecuted: row.dca_executed,
    dcaTotal: row.dca_total ?? 0,
    createdAt: new Date(row.created_at).getTime(),
    executedAt: row.executed_at ? new Date(row.executed_at).getTime() : null,
    expiresAt: Number(row.expiry) * 1000,
    error: row.error,
    amountOut: row.amount_out,
    txHash: row.tx_hash,
  }
}

// ── Hook ─────────────────────────────────────────────────
export function useOrderEngine() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()

  const [orders, setOrders] = useState<AutonomousOrder[]>([])
  const [latestEvent, setLatestEvent] = useState<OrderEngineEvent | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Read current nonce + invalidated nonce from contract ──
  const { data: currentNonce } = useReadContract({
    address: ORDER_EXECUTOR_ADDRESS,
    abi: ORDER_EXECUTOR_ABI,
    functionName: 'nonces',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })
  const { data: currentInvalidatedNonce } = useReadContract({
    address: ORDER_EXECUTOR_ADDRESS,
    abi: ORDER_EXECUTOR_ABI,
    functionName: 'invalidatedNonces',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  // ── Load orders on mount ───────────────────────────────
  useEffect(() => {
    if (!address) {
      setOrders([])
      setIsLoading(false)
      return
    }

    // Load from localStorage immediately
    const local = loadOrders().filter(o =>
      o.order?.owner?.toLowerCase() === address.toLowerCase()
    )
    setOrders(local)

    // Then refresh from Supabase
    fetchUserOrders(address).then(rows => {
      if (rows.length > 0) {
        const remote = rows.map(rowToOrder)
        setOrders(remote)
        saveOrders(remote)
      }
      setIsLoading(false)
    }).catch(() => setIsLoading(false))
  }, [address])

  // ── Save on change (including clearing when empty) ─────
  useEffect(() => {
    // [BUGFIX] Also persist when orders array is empty — prevents stale data in localStorage
    saveOrders(orders)
  }, [orders])

  // ── Poll active orders ─────────────────────────────────
  // [BUGFIX] Compute count outside useEffect to avoid inline .filter() in deps
  const activeCount = orders.filter(o =>
    o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled'
  ).length
  useEffect(() => {
    if (!address) return

    if (activeCount === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }

    async function pollStatus() {
      if (!address) return
      try {
        const rows = await fetchActiveOrders(address!)
        if (rows.length === 0) return

        setOrders(prev => {
          const updated = [...prev]
          for (const row of rows) {
            const idx = updated.findIndex(o => o.orderHash === row.order_hash)
            if (idx >= 0) {
              const newStatus = row.status as AutonomousOrderStatus
              if (updated[idx].status !== newStatus) {
                updated[idx] = { ...updated[idx], status: newStatus, dcaExecuted: row.dca_executed, txHash: row.tx_hash, amountOut: row.amount_out, error: row.error }

                if (newStatus === 'filled') {
                  setLatestEvent({ type: 'order_filled', orderId: updated[idx].id, txHash: row.tx_hash ?? '' })
                }
              }
            }
          }
          return updated
        })
      } catch { /* retry next tick */ }
    }

    pollStatus()
    pollRef.current = setInterval(pollStatus, ORDER_POLL_INTERVAL_MS)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [address, activeCount])

  // ── Real-time Supabase subscription ────────────────────
  useEffect(() => {
    if (!address) return

    const unsub = subscribeToOrders(address, (row: OrderRow) => {
      setOrders(prev => prev.map(o =>
        o.orderHash === row.order_hash
          ? { ...o, status: row.status as AutonomousOrderStatus, dcaExecuted: row.dca_executed, txHash: row.tx_hash, amountOut: row.amount_out, error: row.error, executedAt: row.executed_at ? new Date(row.executed_at).getTime() : o.executedAt }
          : o
      ))
    })

    return unsub
  }, [address])

  // ── Create + sign + submit order ───────────────────────
  const createOrder = useCallback(async (config: CreateOrderConfig) => {
    if (!address) throw new Error('Wallet not connected')

    setIsSubmitting(true)
    const orderId = crypto.randomUUID()

    const nonce = currentNonce !== undefined ? BigInt(currentNonce.toString()) : 0n
    const expiry = BigInt(Math.floor(Date.now() / 1000) + config.expirySeconds)

    // Build on-chain order struct
    const order: OnChainOrder = {
      owner: address,
      tokenIn: config.tokenIn.address as `0x${string}`,
      tokenOut: config.tokenOut.address as `0x${string}`,
      amountIn: BigInt(config.amountIn),
      minAmountOut: BigInt(config.minAmountOut),
      orderType: config.orderType,
      condition: config.condition,
      targetPrice: BigInt(config.targetPrice),
      priceFeed: config.priceFeed as `0x${string}`,
      expiry,
      nonce,
      router: config.router as `0x${string}`,
      routerDataHash: config.routerDataHash ?? '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,  // [C-01] — ZeroHash for DCA (calldata varies per execution)
      dcaInterval: BigInt(config.dcaInterval ?? 0),
      // [BUGFIX] Default to 1 (not 0) to match API default — prevents order hash mismatch
      dcaTotal: BigInt(config.dcaTotal ?? 1),
    }

    // Compute bytes32 orderHash client-side (matches contract's getOrderHash — no RPC needed)
    const computedHash = computeOrderHash(order)

    // Create local record
    const typeLabel = config.orderType === OrderType.LIMIT ? 'limit'
      : config.orderType === OrderType.STOP_LOSS ? 'stop_loss' : 'dca'

    const newOrder: AutonomousOrder = {
      id: orderId,
      orderHash: computedHash,
      order,
      signature: '',
      status: 'signing',
      orderType: config.orderType,
      tokenInSymbol: config.tokenIn.symbol,
      tokenInDecimals: config.tokenIn.decimals,
      tokenOutSymbol: config.tokenOut.symbol,
      tokenOutDecimals: config.tokenOut.decimals,
      dcaExecuted: 0,
      dcaTotal: config.dcaTotal ?? 0,
      createdAt: Date.now(),
      executedAt: null,
      expiresAt: Number(expiry) * 1000,
      error: null,
      amountOut: null,
      txHash: null,
    }

    setOrders(prev => [newOrder, ...prev])

    try {
      // EIP-712 domain (dynamic chainId)
      const domain = {
        name: 'TeraSwapOrderExecutor',
        version: '2',
        chainId,
        verifyingContract: ORDER_EXECUTOR_ADDRESS,
      } as const

      // Sign order
      const signature = await signTypedDataAsync({
        domain,
        types: ORDER_EIP712_TYPES,
        primaryType: 'Order',
        message: {
          owner: order.owner,
          tokenIn: order.tokenIn,
          tokenOut: order.tokenOut,
          amountIn: order.amountIn,
          minAmountOut: order.minAmountOut,
          orderType: order.orderType,
          condition: order.condition,
          targetPrice: order.targetPrice,
          priceFeed: order.priceFeed,
          expiry: order.expiry,
          nonce: order.nonce,
          router: order.router,
          routerDataHash: order.routerDataHash,  // [C-01]
          dcaInterval: order.dcaInterval,
          dcaTotal: order.dcaTotal,
        },
      })

      // Submit to Supabase
      const row = await createOrderInSupabase({
        wallet: address,
        orderHash: computedHash, // Real bytes32 hash from contract's getOrderHash
        orderType: typeLabel,
        tokenIn: config.tokenIn.address,
        tokenOut: config.tokenOut.address,
        amountIn: config.amountIn,
        minAmountOut: config.minAmountOut,
        targetPrice: config.targetPrice,
        priceFeed: config.priceFeed,
        priceCondition: config.condition === PriceCondition.ABOVE ? 'above' : 'below',
        expiry: new Date(Number(expiry) * 1000),
        nonce: Number(nonce),
        router: config.router,
        dcaInterval: config.dcaInterval ?? null,
        dcaTotal: config.dcaTotal ?? null,
        signature,
        orderData: {
          owner: order.owner,
          tokenIn: order.tokenIn,
          tokenOut: order.tokenOut,
          amountIn: order.amountIn.toString(),
          minAmountOut: order.minAmountOut.toString(),
          orderType: order.orderType,
          condition: order.condition,
          targetPrice: order.targetPrice.toString(),
          priceFeed: order.priceFeed,
          expiry: order.expiry.toString(),
          nonce: order.nonce.toString(),
          router: order.router,
          routerDataHash: order.routerDataHash,  // [C-01]
          dcaInterval: order.dcaInterval.toString(),
          dcaTotal: order.dcaTotal.toString(),
        },
        tokenInSymbol: config.tokenIn.symbol,
        tokenOutSymbol: config.tokenOut.symbol,
        tokenInDecimals: config.tokenIn.decimals,
        tokenOutDecimals: config.tokenOut.decimals,
      })

      const orderHash = row?.order_hash ?? computedHash

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, orderHash, signature, status: 'active' as AutonomousOrderStatus }
          : o
      ))

      setLatestEvent({ type: 'order_created', orderId, orderHash })
    } catch (err) {
      const errorMsg = err instanceof Error
        ? (err.message.toLowerCase().includes('user rejected')
            ? 'Signature rejected in wallet.'
            : err.message.slice(0, 120))
        : 'Unknown error'

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, status: 'error' as AutonomousOrderStatus, error: errorMsg }
          : o
      ))
      setLatestEvent({ type: 'order_error', orderId, error: errorMsg })
    } finally {
      setIsSubmitting(false)
    }
  }, [address, chainId, signTypedDataAsync, currentNonce])

  // ── Cancel order (on-chain + Supabase) ─────────────────
  const cancelOrder = useCallback(async (orderId: string) => {
    if (!address) return
    const order = orders.find(o => o.id === orderId)
    if (!order) return

    try {
      // Reconstruct the order struct with proper BigInt types (may be strings from localStorage)
      const o = order.order
      const orderStruct = {
        owner: o.owner,
        tokenIn: o.tokenIn,
        tokenOut: o.tokenOut,
        amountIn: BigInt(o.amountIn.toString()),
        minAmountOut: BigInt(o.minAmountOut.toString()),
        orderType: Number(o.orderType),
        condition: Number(o.condition),
        targetPrice: BigInt(o.targetPrice.toString()),
        priceFeed: o.priceFeed,
        expiry: BigInt(o.expiry.toString()),
        nonce: BigInt(o.nonce.toString()),
        router: o.router,
        routerDataHash: o.routerDataHash || '0x0000000000000000000000000000000000000000000000000000000000000000',  // [C-01]
        dcaInterval: BigInt(o.dcaInterval.toString()),
        dcaTotal: BigInt(o.dcaTotal.toString()),
      }

      // Cancel on-chain — contract verifies msg.sender == order.owner, then marks hash as cancelled
      await writeContractAsync({
        address: ORDER_EXECUTOR_ADDRESS,
        abi: ORDER_EXECUTOR_ABI,
        functionName: 'cancelOrder',
        args: [orderStruct],
      })

      // Cancel in Supabase (uses the stored order_hash, which may be UUID or bytes32)
      await cancelOrderInSupabase(address, order.orderHash)

      setOrders(prev => prev.map(o =>
        o.id === orderId
          ? { ...o, status: 'cancelled' as AutonomousOrderStatus }
          : o
      ))
      setLatestEvent({ type: 'order_cancelled', orderId })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message.slice(0, 120) : 'Cancel failed'
      setLatestEvent({ type: 'order_error', orderId, error: errorMsg })
    }
  }, [address, orders, writeContractAsync])

  // ── Cancel ALL active orders in one tx (nonce invalidation) ──
  const cancelAllOrders = useCallback(async () => {
    if (!address) return
    const nonce = currentNonce !== undefined ? BigInt(currentNonce.toString()) : 0n
    const invalidated = currentInvalidatedNonce !== undefined ? BigInt(currentInvalidatedNonce.toString()) : 0n
    // newNonce must be > invalidatedNonces[user] AND should cover all current orders
    const newNonce = (nonce > invalidated ? nonce : invalidated) + 1n

    try {
      await writeContractAsync({
        address: ORDER_EXECUTOR_ADDRESS,
        abi: ORDER_EXECUTOR_ABI,
        functionName: 'invalidateNonces',
        args: [newNonce],
      })

      // Mark all active orders as cancelled in Supabase + local state
      const active = orders.filter(o =>
        o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled'
      )

      for (const order of active) {
        await cancelOrderInSupabase(address, order.orderHash).catch(() => {})
      }

      setOrders(prev => prev.map(o =>
        (o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled')
          ? { ...o, status: 'cancelled' as AutonomousOrderStatus }
          : o
      ))

      setLatestEvent({ type: 'order_cancelled', orderId: 'all' })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message.slice(0, 120) : 'Cancel all failed'
      setLatestEvent({ type: 'order_error', orderId: 'all', error: errorMsg })
    }
  }, [address, orders, writeContractAsync, currentNonce, currentInvalidatedNonce])

  // ── Remove order from local list ───────────────────────
  const removeOrder = useCallback((orderId: string) => {
    setOrders(prev => {
      const updated = prev.filter(o => o.id !== orderId)
      saveOrders(updated)
      return updated
    })
  }, [])

  // ── Derived data ───────────────────────────────────────
  const activeOrders = orders.filter(o =>
    o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled' || o.status === 'signing'
  )
  const historyOrders = orders.filter(o =>
    o.status === 'filled' || o.status === 'expired' || o.status === 'cancelled' || o.status === 'error'
  )
  const limitOrders = orders.filter(o => o.orderType === OrderType.LIMIT)
  const stopLossOrders = orders.filter(o => o.orderType === OrderType.STOP_LOSS)
  const dcaOrders = orders.filter(o => o.orderType === OrderType.DCA)

  return {
    orders,
    activeOrders,
    historyOrders,
    limitOrders,
    stopLossOrders,
    dcaOrders,
    latestEvent,
    isSubmitting,
    isLoading,
    currentNonce: currentNonce ? BigInt(currentNonce.toString()) : 0n,
    createOrder,
    cancelOrder,
    cancelAllOrders,
    removeOrder,
  }
}
