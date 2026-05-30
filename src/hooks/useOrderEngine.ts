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
  CANCEL_ORDER_TYPES,
  getOrderExecutorDomain,
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
import { initSecureStorage, secureGet, secureSet } from '@/lib/secure-storage'

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
// [P200] Orders are encrypted at rest via SecureStorage (AES-256-GCM, key
// derived from the connected wallet). The v4 key marks the encrypted format;
// v3 used weak XOR obfuscation and is migrated + removed on first load.
const STORAGE_KEY = 'teraswap_orders_v4'

// Legacy v3 key + XOR constant — retained ONLY to migrate existing
// plaintext/obfuscated data into the encrypted store, then deleted. No new
// write ever takes this path (the encoder was removed in P200).
const LEGACY_XOR_KEY = 'teraswap_orders_v3'
const LEGACY_OBFUSCATION_KEY = 'TeraSwap_2026_v3'

/** Decode-only XOR (mirror of the removed `obfuscate`) for v3 → v4 migration. */
function legacyDeobfuscate(encoded: string): string {
  try {
    const data = atob(encoded)
    const key = LEGACY_OBFUSCATION_KEY
    let result = ''
    for (let i = 0; i < data.length; i++) {
      result += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % key.length))
    }
    return result
  } catch { return '' }
}

/** Read the legacy v3 payload: try XOR-decode first, then plain JSON. */
function readLegacyOrders(): AutonomousOrder[] {
  if (typeof window === 'undefined') return []
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_XOR_KEY)
  } catch { return [] }
  if (!raw) return []
  try {
    return JSON.parse(legacyDeobfuscate(raw))
  } catch {
    try {
      return JSON.parse(raw)
    } catch {
      return []
    }
  }
}

/**
 * Load orders from the encrypted v4 store, transparently migrating any legacy
 * v3 data on first run. Async because AES-GCM decryption is async.
 */
async function loadOrders(): Promise<AutonomousOrder[]> {
  if (typeof window === 'undefined') return []
  const encrypted = await secureGet<AutonomousOrder[]>(STORAGE_KEY)
  if (encrypted && encrypted.length > 0) return encrypted

  // No encrypted data yet — attempt a one-time migration from legacy v3.
  const legacy = readLegacyOrders()
  if (legacy.length > 0) {
    await saveOrders(legacy)
    try { localStorage.removeItem(LEGACY_XOR_KEY) } catch { /* ignore */ }
    return legacy
  }
  // Either genuinely empty, or v4 held an empty array.
  return encrypted ?? []
}

/** Encrypt + persist the order list under the v4 key. */
async function saveOrders(orders: AutonomousOrder[]): Promise<void> {
  if (typeof window === 'undefined') return
  // Pre-serialise BigInt → string; SecureStorage's internal JSON.stringify
  // cannot handle BigInt on its own.
  const serialisable = JSON.parse(
    JSON.stringify(orders, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )
  await secureSet(STORAGE_KEY, serialisable)
}

// ── Dismissed orders (UI-only soft-delete) ───────────────
// Cancelled/terminal orders stay in Supabase for the audit trail, so a
// page refresh re-syncs them from the server and they reappear. Persisting
// the IDs the user has explicitly dismissed keeps them hidden across
// reloads. No Supabase row is ever deleted.
const DISMISSED_ORDERS_KEY = 'teraswap_dismissed_orders'

function getDismissedOrderIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = localStorage.getItem(DISMISSED_ORDERS_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

function dismissOrder(orderId: string): void {
  if (typeof window === 'undefined') return
  const ids = getDismissedOrderIds()
  if (!ids.includes(orderId)) {
    ids.push(orderId)
    try {
      localStorage.setItem(DISMISSED_ORDERS_KEY, JSON.stringify(ids))
    } catch { /* quota exceeded */ }
  }
}

// ── Convert Supabase row → UI order ──────────────────────

/** Map DB status strings to UI status strings.
 *  DB uses 'executed'/'failed', UI uses 'filled'/'error'. */
function mapDbStatus(dbStatus: string): AutonomousOrderStatus {
  if (dbStatus === 'executed') return 'filled'
  if (dbStatus === 'failed') return 'error'
  return dbStatus as AutonomousOrderStatus
}

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
    status: mapDbStatus(row.status as string),
    orderType: typeMap[row.order_type] ?? OrderType.LIMIT,
    tokenInSymbol: row.token_in_symbol || '',
    tokenInDecimals: 18,
    tokenOutSymbol: row.token_out_symbol || '',
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
  // [P200] Guard: don't persist the initial empty array before the async load
  // resolves — otherwise the save effect would clobber the encrypted store.
  const hasLoadedRef = useRef(false)

  // [P213/FULL-M-06] Local session nonce tracking. Two orders created before
  // wagmi re-fetches `nonces(user)` would otherwise read the same on-chain
  // value and produce a colliding nonce (the second order unexecutable).
  // `localNonceRef` remembers the highest nonce issued this session;
  // `creatingRef` is a mutex that serialises createOrder calls.
  const localNonceRef = useRef<bigint | null>(null)
  const creatingRef = useRef(false)

  // ── Read current nonce + invalidated nonce from contract ──
  const { data: currentNonce, refetch: refetchNonce } = useReadContract({
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

  // ── Load orders on mount / wallet change ───────────────
  useEffect(() => {
    // Reset the persist guard so the new wallet's load can't be pre-empted by
    // a stale save, and so a disconnected → connected transition reloads.
    hasLoadedRef.current = false

    if (!address) {
      setOrders([])
      setIsLoading(false)
      return
    }

    // Derive this wallet's AES-GCM key before any secure read/write.
    initSecureStorage(address)

    let cancelled = false

    void (async () => {
      // 1. Local (encrypted) cache — decrypt + filter to this wallet.
      const local = (await loadOrders()).filter(o =>
        o.order?.owner?.toLowerCase() === address.toLowerCase(),
      )
      if (cancelled) return

      // Merge-guard: if another effect (e.g. a realtime event) already
      // populated state during the await, append local-only orders instead of
      // clobbering it.
      setOrders(prev => {
        if (prev.length === 0) return local
        const seen = new Set(prev.map(o => o.id))
        return [...prev, ...local.filter(o => !seen.has(o.id))]
      })
      // Loading is done — allow the save effect to persist subsequent changes.
      hasLoadedRef.current = true

      // 2. Refresh from Supabase (authoritative source).
      try {
        const rows = await fetchUserOrders(address)
        if (cancelled) return
        if (rows.length > 0) {
          const dismissed = getDismissedOrderIds()
          const remote = rows.map(rowToOrder).filter(o => !dismissed.includes(o.id))
          setOrders(remote)
        }
      } catch {
        /* keep the local cache on network error */
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [address])

  // ── Save on change (including clearing when empty) ─────
  useEffect(() => {
    // [P200] Skip until the async load has populated state — otherwise the
    // initial empty array would overwrite the encrypted store.
    if (!hasLoadedRef.current) return
    void saveOrders(orders)
  }, [orders])

  // ── [P213/FULL-M-06] Reset session nonce tracking on account change ──
  // A new (or disconnected) wallet starts fresh from its own on-chain nonce —
  // never carry over the previous account's local high-water mark.
  useEffect(() => {
    localNonceRef.current = null
  }, [address])

  // [P213/FULL-M-06] Next nonce for an order: max(on-chain, local+1). Defers to
  // the on-chain value when it's higher (another session/device advanced it),
  // otherwise increments the local high-water mark so rapid sequential creates
  // never collide before wagmi re-fetches.
  const getNextNonce = useCallback((): bigint => {
    const onChainNonce = currentNonce !== undefined ? BigInt(currentNonce.toString()) : 0n
    const localNonce = localNonceRef.current
    const next = localNonce !== null
      ? (localNonce + 1n > onChainNonce ? localNonce + 1n : onChainNonce)
      : onChainNonce
    localNonceRef.current = next
    return next
  }, [currentNonce])

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
              const newStatus = mapDbStatus(row.status as string)
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
          ? { ...o, status: mapDbStatus(row.status as string), dcaExecuted: row.dca_executed, txHash: row.tx_hash, amountOut: row.amount_out, error: row.error, executedAt: row.executed_at ? new Date(row.executed_at).getTime() : o.executedAt }
          : o
      ))
    })

    return unsub
  }, [address])

  // ── Create + sign + submit order ───────────────────────
  const createOrder = useCallback(async (config: CreateOrderConfig) => {
    if (!address) throw new Error('Wallet not connected')

    // [P213/FULL-M-06] Serialise creates — two concurrent calls would read the
    // same nonce before refetch and collide.
    if (creatingRef.current) {
      throw new Error('Order creation in progress — please wait')
    }
    creatingRef.current = true

    setIsSubmitting(true)
    const orderId = crypto.randomUUID()

    // [P213/FULL-M-06] Session-tracked nonce (max of on-chain and local+1)
    // instead of the raw wagmi read, so rapid sequential creates don't collide.
    const nonce = getNextNonce()
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

      // [P213/FULL-M-06] Sync the on-chain nonce now that this order consumed
      // one, so the next on-chain comparison reflects the advance.
      refetchNonce().catch(() => {})

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
      creatingRef.current = false // [P213] release the create mutex
    }
  }, [address, chainId, signTypedDataAsync, getNextNonce, refetchNonce])

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

      // Cancel in Supabase (uses the stored order_hash, which may be UUID or bytes32).
      // [FULL-H-01] The PATCH endpoint now requires an EIP-712 CancelOrder
      // signature. We sign over the resolved Supabase row id so the server can
      // recover the signer and confirm ownership. A declined signature is
      // swallowed by cancelOrderInSupabase (returns false) — the on-chain
      // cancel above is authoritative, so the order is still cancelled.
      await cancelOrderInSupabase(address, order.orderHash, async (rowId) => {
        const signature = await signTypedDataAsync({
          domain: getOrderExecutorDomain(chainId),
          types: CANCEL_ORDER_TYPES,
          primaryType: 'CancelOrder',
          message: { id: rowId, action: 'cancel' },
        })
        return { signature, chainId }
      })

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
  }, [address, orders, writeContractAsync, chainId, signTypedDataAsync])

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

      // Mark all active orders as cancelled in Supabase + local state.
      // [FULL-H-01] The PATCH endpoint now requires an EIP-712 CancelOrder
      // signature, so each per-order Supabase sync must be signed too — without
      // this the rows would stay 'active' in Supabase while the chain + local
      // UI show 'cancelled' (DB/chain divergence). One signature per active
      // order; declined signatures are swallowed (on-chain invalidateNonces is
      // authoritative regardless).
      const active = orders.filter(o =>
        o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled'
      )

      for (const order of active) {
        await cancelOrderInSupabase(address, order.orderHash, async (rowId) => {
          const signature = await signTypedDataAsync({
            domain: getOrderExecutorDomain(chainId),
            types: CANCEL_ORDER_TYPES,
            primaryType: 'CancelOrder',
            message: { id: rowId, action: 'cancel' },
          })
          return { signature, chainId }
        }).catch(() => {})
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
  }, [address, orders, writeContractAsync, currentNonce, currentInvalidatedNonce, chainId, signTypedDataAsync])

  // ── Remove order from local list ───────────────────────
  const removeOrder = useCallback((orderId: string) => {
    setOrders(prev => {
      const target = prev.find(o => o.id === orderId)
      if (!target) return prev
      // Active orders must be cancelled on-chain, not dismissed.
      const isActive = target.status === 'active'
        || target.status === 'executing'
        || target.status === 'partially_filled'
        || target.status === 'signing'
      if (isActive) return prev
      // Persist the dismissal so a Supabase re-sync on reload doesn't
      // resurrect the order (the row stays in the DB for the audit trail).
      dismissOrder(orderId)
      const updated = prev.filter(o => o.id !== orderId)
      void saveOrders(updated)
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
