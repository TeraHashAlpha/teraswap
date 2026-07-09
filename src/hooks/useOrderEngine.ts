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
  getOrderExecutor,
  MIN_ORDER_AMOUNT,
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
  ensureOrdersReadAuth,
  retryOrdersReadAuth,
  ReadAuthRequiredError,
  // [SPRINT-V3-P2] v3 signing — fail-closed while getOrderExecutorV3(chainId) is null.
  getOrderExecutorV3,
  getOrderExecutorV3Domain,
  ORDER_V3_EIP712_TYPES,
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
import { NATIVE_ETH } from '@/lib/constants'
import { getWrappedNative } from '@/lib/chains/registry'
import { findChainToken } from '@/lib/chains/tokens'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

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

// [SPRINT-V3-P2 / ADR-013 §1] v3 adds maxSlippageBps (uint16) right after minAmountOut — mirrors
// contracts/order-engine/TeraSwapOrderExecutorV3.sol's ORDER_TYPEHASH field-for-field (pinned in
// lib/order-engine/types.test.ts against the .sol source). A v3 order is one whose
// order.maxSlippageBps is defined; a v2 order never sets it.
const ORDER_V3_TYPEHASH = keccak256(toBytes(
  'Order(address owner,address tokenIn,address tokenOut,uint256 amountIn,' +
  'uint256 minAmountOut,uint16 maxSlippageBps,uint8 orderType,uint8 condition,' +
  'uint256 targetPrice,address priceFeed,uint256 expiry,uint256 nonce,address router,' +
  'bytes32 routerDataHash,uint256 dcaInterval,uint256 dcaTotal)'
))

const ORDER_V3_HASH_PARAMS = [
  { type: 'bytes32' as const },
  { type: 'address' as const },
  { type: 'address' as const },
  { type: 'address' as const },
  { type: 'uint256' as const },
  { type: 'uint256' as const },
  { type: 'uint16' as const },   // maxSlippageBps [ADR-013 §1]
  { type: 'uint8' as const },
  { type: 'uint8' as const },
  { type: 'uint256' as const },
  { type: 'address' as const },
  { type: 'uint256' as const },
  { type: 'uint256' as const },
  { type: 'address' as const },
  { type: 'bytes32' as const },
  { type: 'uint256' as const },
  { type: 'uint256' as const },
]

/** Pure client-side computation — no RPC call needed. Dispatches to the v3 typehash/params when
 *  order.maxSlippageBps is defined, else the v2 path (byte-identical to before). */
function computeOrderHash(order: OnChainOrder): `0x${string}` {
  if (order.maxSlippageBps !== undefined) {
    return keccak256(encodeAbiParameters(ORDER_V3_HASH_PARAMS, [
      ORDER_V3_TYPEHASH,
      order.owner,
      order.tokenIn,
      order.tokenOut,
      BigInt(order.amountIn.toString()),
      BigInt(order.minAmountOut.toString()),
      order.maxSlippageBps,
      Number(order.orderType),
      Number(order.condition),
      BigInt(order.targetPrice.toString()),
      order.priceFeed,
      BigInt(order.expiry.toString()),
      BigInt(order.nonce.toString()),
      order.router,
      order.routerDataHash,
      BigInt(order.dcaInterval.toString()),
      BigInt(order.dcaTotal.toString()),
    ]))
  }
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
    // [CHORE-DCA-POSITIONS-DASHBOARD] Thread the chain (BaseScan links + chain-keyed logos) and the
    // REAL token decimals (was hardcoded 18 → wrong amounts for USDC(6) etc.). Safe defaults preserve
    // legacy/mainnet behaviour byte-identically.
    chainId: row.chain_id ?? DEFAULT_CHAIN_ID,
    tokenInSymbol: row.token_in_symbol || '',
    tokenInDecimals: row.token_in_decimals ?? 18,
    tokenOutSymbol: row.token_out_symbol || '',
    tokenOutDecimals: row.token_out_decimals ?? 18,
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
/**
 * [SPRINT-9U U2] A frozen autonomous-order awaiting the user's review before the EIP-712 signature.
 * createOrder (Phase A) builds + FREEZES this; confirmOrder (Phase B) signs the SAME struct 1:1. The
 * review modal renders exclusively from it, so modal == signed payload. chainId/account are captured
 * for a synchronous re-check at confirm time (alongside the chain/account-switch reset effects).
 */
export interface PendingOrderReview {
  order: OnChainOrder
  config: CreateOrderConfig
  computedHash: `0x${string}`
  chainId: number
  account: `0x${string}`
}

/**
 * [CANCEL-REVIEW] A frozen cancel/invalidate plan awaiting the user's review — closes the 9U FEEDBACK
 * gap: cancel/invalidate signatures (and the on-chain cancel tx) were un-gated. cancelOrder /
 * cancelAllOrders (Phase A) FREEZE this; confirmCancel (Phase B) executes the SAME frozen payload 1:1
 * (`orderStruct` is the exact cancelOrder() tx arg; `newNonce` the exact invalidateNonces() arg). The
 * review modal renders exclusively from it, so modal == executed payload. chainId/account are captured
 * for the synchronous confirm-time re-check (alongside the chain/account-switch reset effects).
 * Chain-agnostic: carries the ACTIVE chainId (Base-ready), never assumes mainnet.
 */
export type PendingCancelReview =
  | {
      action: 'cancel'
      orderId: string
      order: AutonomousOrder
      orderStruct: OnChainOrder
      chainId: number
      account: `0x${string}`
    }
  | {
      action: 'invalidate'
      newNonce: bigint
      affectedOrders: AutonomousOrder[]
      chainId: number
      account: `0x${string}`
    }

export function useOrderEngine() {
  const { address } = useAccount()
  const chainId = useChainId()
  // [CHORE-ORDER-EXEC-PREP A] Resolve the OrderExecutor for the connected chain. null = no executor
  // deployed there (e.g. Base today) → order creation / signing / on-chain reads are fail-closed.
  const orderExecutor = getOrderExecutor(chainId)
  // [SPRINT-V3-P2] v3 executor for the connected chain. null on every chain today (v3 is not
  // deployed) — createOrder/confirmOrder only take the v3 signing branch when this is non-null
  // AND the caller's config explicitly requested it (maxSlippageBps set); otherwise the v2 path
  // below is exercised exactly as before.
  const orderExecutorV3 = getOrderExecutorV3(chainId)
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()

  const [orders, setOrders] = useState<AutonomousOrder[]>([])
  // [SPRINT-9U U2] Frozen order awaiting review before the EIP-712 signature.
  const [pendingOrder, setPendingOrder] = useState<PendingOrderReview | null>(null)
  // [CANCEL-REVIEW] Frozen cancel/invalidate plan awaiting review before any tx/signature.
  const [pendingCancel, setPendingCancel] = useState<PendingCancelReview | null>(null)
  const [latestEvent, setLatestEvent] = useState<OrderEngineEvent | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  // [AUDIT-W6 / W6-M-01] Active-order reads need one session signature. True
  // when the user rejected the prompt — the UI offers an explicit retry
  // (requestOrdersReadAuth) instead of popup-spamming.
  const [readAuthDenied, setReadAuthDenied] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // [P200] Guard: don't persist the initial empty array before the async load
  // resolves — otherwise the save effect would clobber the encrypted store.
  const hasLoadedRef = useRef(false)

  // [AUDIT-W6 / W6-M-01] Run an orders fetch; on the server's 401
  // READ_AUTH_REQUIRED, sign the session read message ONCE (deduped +
  // denial-remembered in read-auth.ts) and retry. Kept in a ref so the load
  // and poll effects don't gain re-run dependencies.
  const withReadAuthRef = useRef<(fetchFn: () => Promise<OrderRow[]>) => Promise<OrderRow[]>>(
    async (fetchFn) => fetchFn(),
  )
  withReadAuthRef.current = async (fetchFn) => {
    try {
      return await fetchFn()
    } catch (err) {
      if (!(err instanceof ReadAuthRequiredError) || !address) throw err
      const outcome = await ensureOrdersReadAuth(address, (typed) =>
        signTypedDataAsync(typed as Parameters<typeof signTypedDataAsync>[0]),
      )
      if (outcome !== 'ok') {
        setReadAuthDenied(true)
        return []
      }
      setReadAuthDenied(false)
      return fetchFn()
    }
  }

  // [P213/FULL-M-06] Local session nonce tracking. Two orders created before
  // wagmi re-fetches `nonces(user)` would otherwise read the same on-chain
  // value and produce a colliding nonce (the second order unexecutable).
  // `localNonceRef` remembers the highest nonce issued this session;
  // `creatingRef` is a mutex that serialises createOrder calls.
  const localNonceRef = useRef<bigint | null>(null)
  const creatingRef = useRef(false)

  // [SPRINT-9U U2 / 9R defense] Discard a pending review on chain/account switch — never sign an
  // order reviewed under chain/account A while connected as B. Ref comparison fires only on a change.
  // [CANCEL-REVIEW] The same invalidation applies to a frozen cancel/invalidate plan.
  const prevOrderChainRef = useRef(chainId)
  useEffect(() => {
    if (prevOrderChainRef.current !== chainId) {
      setPendingOrder(null)
      setPendingCancel(null)
    }
    prevOrderChainRef.current = chainId
  }, [chainId])
  const prevOrderAddrRef = useRef(address)
  useEffect(() => {
    const prev = prevOrderAddrRef.current
    if ((prev && address && prev !== address) || (prev && !address)) {
      setPendingOrder(null)
      setPendingCancel(null)
    }
    prevOrderAddrRef.current = address
  }, [address])

  // ── Read current nonce + invalidated nonce from contract ──
  const { data: currentNonce, refetch: refetchNonce } = useReadContract({
    address: orderExecutor ?? undefined,
    abi: ORDER_EXECUTOR_ABI,
    functionName: 'nonces',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!orderExecutor }, // fail-closed: no executor on this chain → no read
  })
  const { data: currentInvalidatedNonce } = useReadContract({
    address: orderExecutor ?? undefined,
    abi: ORDER_EXECUTOR_ABI,
    functionName: 'invalidatedNonces',
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!orderExecutor },
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
        // [W6-M-01] May prompt for the one-per-session read signature.
        const rows = await withReadAuthRef.current(() => fetchUserOrders(address))
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
        // [W6-M-01] Uses the cached session signature; signs once if missing.
        const rows = await withReadAuthRef.current(() => fetchActiveOrders(address!))
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

  // ── [SPRINT-9U U2] Create order = Phase A: build + FREEZE for review (NO signature here) ────────
  const createOrder = useCallback(async (config: CreateOrderConfig) => {
    if (!address) throw new Error('Wallet not connected')

    // [CHORE-DCA-PRELAUNCH-FIXES Fix 1] Pre-sign floor guard. Reject BEFORE freezing for
    // review / signing / persisting when the per-execution amount is below the contract's
    // MIN_ORDER_AMOUNT, so the user is never asked to spend an EIP-712 signature on an order
    // the contract will revert (DCAChunkTooSmall / OrderTooSmall). DCA divides per chunk via
    // the SAME default the signed struct uses (dcaTotal ?? 1) ⇒ non-DCA reduces to amountIn.
    const perExecution = BigInt(config.amountIn) / BigInt(config.dcaTotal ?? 1)
    if (perExecution < MIN_ORDER_AMOUNT) {
      const isDca = (config.dcaTotal ?? 1) > 1
      setLatestEvent({
        type: 'order_error',
        orderId: crypto.randomUUID(),
        error: isDca
          ? `Each DCA buy must be at least ${Number(MIN_ORDER_AMOUNT).toLocaleString()} base units (the on-chain minimum). Increase the total amount or reduce the number of buys.`
          : `Order amount must be at least ${Number(MIN_ORDER_AMOUNT).toLocaleString()} base units (the on-chain minimum).`,
      })
      return
    }

    // [CHORE-DCA-WETH-INPUT] Defense-in-depth: a conditional order's tokenIn (spend token)
    // must be an ERC-20 — the OrderExecutor pulls it via a DIRECT ERC-20 allowance/transferFrom
    // to the executor (NOT Permit2; see useOrderApproval), which the native-ETH sentinel can't
    // satisfy (the contract would revert, wasting an EIP-712
    // signature). The UI hides native ETH from the DCA INPUT selector, but resolve the
    // sentinel here too (chain-aware WETH, never hardcoded) so it can NEVER reach the signed
    // struct. tokenOut is left untouched — native ETH is a valid OUTPUT (contract unwraps).
    const tokenInAddress = config.tokenIn.address.toLowerCase() === NATIVE_ETH.toLowerCase()
      ? getWrappedNative(chainId)
      : (config.tokenIn.address as `0x${string}`)

    // [P213/FULL-M-06] Session-tracked nonce (max of on-chain and local+1)
    // instead of the raw wagmi read, so rapid sequential creates don't collide.
    const nonce = getNextNonce()
    const expiry = BigInt(Math.floor(Date.now() / 1000) + config.expirySeconds)

    // [SPRINT-V3-P2] v3 signing requires BOTH the caller opting in (config.maxSlippageBps set —
    // DCAPanel only does this after deriving a real absolute min) AND the connected chain actually
    // having a v3 executor configured. Either missing ⇒ fall back to the v2 struct, unchanged.
    const signV3 = config.maxSlippageBps !== undefined && orderExecutorV3 !== null

    // Build on-chain order struct
    const order: OnChainOrder = {
      owner: address,
      tokenIn: tokenInAddress,
      tokenOut: config.tokenOut.address as `0x${string}`,
      amountIn: BigInt(config.amountIn),
      minAmountOut: BigInt(config.minAmountOut),
      ...(signV3 ? { maxSlippageBps: config.maxSlippageBps } : {}),
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

    // [SPRINT-9U U2] FREEZE for review — confirmOrder signs THIS exact struct 1:1 (no rebuild).
    // Re-calling createOrder (a re-config / re-quote) overwrites the frozen order → re-review.
    setPendingOrder({ order, config, computedHash, chainId, account: address })
  }, [address, chainId, getNextNonce, setLatestEvent])

  // ── [SPRINT-9U U2] Phase B: sign the FROZEN order + submit (reachable ONLY via the review modal) ──
  const confirmOrder = useCallback(async () => {
    const p = pendingOrder
    if (!p || !address) return
    // [9R defense] Reject a review built under a different chain/account than the one now connected.
    // The reset effects also clear it; this holds the invariant synchronously, independent of timing.
    if (p.chainId !== chainId || p.account.toLowerCase() !== address.toLowerCase()) {
      setPendingOrder(null)
      return
    }
    // [SPRINT-9U audit] Freshness: don't sign an order whose expiry already passed while the review
    // sat open (it could never trigger). Fail-safe → discard + surface an error so the user recreates.
    if (Number(p.order.expiry) <= Math.floor(Date.now() / 1000)) {
      setPendingOrder(null)
      setLatestEvent({ type: 'order_error', orderId: crypto.randomUUID(), error: 'Order expired before signing — please recreate it.' })
      return
    }
    // [CHORE-ORDER-EXEC-PREP A] Fail-closed: never sign an order on a chain with no OrderExecutor
    // (e.g. Base — the same address is the FeeCollector there, not an executor).
    if (!orderExecutor) {
      setPendingOrder(null)
      setLatestEvent({ type: 'order_error', orderId: crypto.randomUUID(), error: `Conditional orders are not yet available on chain ${chainId}.` })
      return
    }
    if (creatingRef.current) return
    creatingRef.current = true
    setPendingOrder(null) // consume the review
    setIsSubmitting(true)

    const { order, config, computedHash } = p
    const orderId = crypto.randomUUID()
    const typeLabel = config.orderType === OrderType.LIMIT ? 'limit'
      : config.orderType === OrderType.STOP_LOSS ? 'stop_loss' : 'dca'

    // [CHORE-DCA-WETH-INPUT] If createOrder remapped a native-ETH input to WETH, the signed
    // struct + persisted token_in already hold the WETH address. Derive the matching display
    // symbol/decimals from the per-chain catalog so the stored/in-memory metadata doesn't keep
    // labelling a WETH address as "ETH". Reachable for limit/stop_loss (whose panels still offer
    // native ETH as input); the order-build guard rewrites it for all conditional types.
    const tokenInRemapped = order.tokenIn.toLowerCase() !== config.tokenIn.address.toLowerCase()
    const resolvedTokenIn = tokenInRemapped ? findChainToken(order.tokenIn, p.chainId) : undefined
    const tokenInSymbol = resolvedTokenIn?.symbol ?? config.tokenIn.symbol
    const tokenInDecimals = resolvedTokenIn?.decimals ?? config.tokenIn.decimals

    const newOrder: AutonomousOrder = {
      id: orderId,
      orderHash: computedHash,
      order,
      signature: '',
      status: 'signing',
      // [CHORE-DCA-POSITIONS-DASHBOARD] Stamp the chain it's signed under (= connected chain) so the
      // optimistic record drives BaseScan links/logos before the Supabase round-trip.
      chainId,
      orderType: config.orderType,
      tokenInSymbol,
      tokenInDecimals,
      tokenOutSymbol: config.tokenOut.symbol,
      tokenOutDecimals: config.tokenOut.decimals,
      dcaExecuted: 0,
      dcaTotal: config.dcaTotal ?? 0,
      createdAt: Date.now(),
      executedAt: null,
      expiresAt: Number(order.expiry) * 1000,
      error: null,
      amountOut: null,
      txHash: null,
    }

    setOrders(prev => [newOrder, ...prev])

    try {
      // [CHORE-ORDER-API-CHAIN-AWARE] Single load-bearing value: the chainId this order is SIGNED
      // under. p.chainId === chainId is already asserted synchronously by the guard above (the
      // p.chainId !== chainId check that clears the review), so the connected chain and the frozen
      // plan's chain are identical here. Using ONE const for BOTH the signing domain AND the POSTed
      // chainId makes the sent == signed invariant explicit — a future refactor cannot let them
      // diverge.
      const signedChainId = chainId
      // [SPRINT-V3-P2] order.maxSlippageBps defined ⇒ this order was built for v3 (createOrder
      // already gated that on orderExecutorV3 !== null) — sign with the v3 domain (version "3")
      // and typed-data schema so it can never verify against v2, and vice-versa. v2 orders take
      // the exact path they always have (getOrderExecutorDomain, ORDER_EIP712_TYPES).
      const isV3Order = order.maxSlippageBps !== undefined
      // [CHORE-ORDER-EXEC-PREP A] EIP-712 domain via the per-chain resolver. Mainnet (chainId 1) is
      // byte-identical to the previous inline domain; it throws on a chain with no executor — but the
      // fail-closed guard above already returned for that case, so this is reached only when valid.
      const domain = isV3Order ? getOrderExecutorV3Domain(signedChainId) : getOrderExecutorDomain(signedChainId)

      // Sign the FROZEN order
      const signature = await signTypedDataAsync({
        domain,
        types: isV3Order ? ORDER_V3_EIP712_TYPES : ORDER_EIP712_TYPES,
        primaryType: 'Order',
        message: isV3Order
          ? {
              owner: order.owner,
              tokenIn: order.tokenIn,
              tokenOut: order.tokenOut,
              amountIn: order.amountIn,
              minAmountOut: order.minAmountOut,
              maxSlippageBps: order.maxSlippageBps!,
              orderType: order.orderType,
              condition: order.condition,
              targetPrice: order.targetPrice,
              priceFeed: order.priceFeed,
              expiry: order.expiry,
              nonce: order.nonce,
              router: order.router,
              routerDataHash: order.routerDataHash,
              dcaInterval: order.dcaInterval,
              dcaTotal: order.dcaTotal,
            }
          : {
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
        // [CHORE-ORDER-API-CHAIN-AWARE] = the chainId used to build the signing domain above; the
        // backend reuses getOrderExecutorDomain(this) for byte-identical recovery (sent == signed).
        chainId: signedChainId,
        orderHash: computedHash, // Real bytes32 hash from contract's getOrderHash
        orderType: typeLabel,
        // [CHORE-DCA-WETH-INPUT] Persist EXACTLY what was signed/hashed (order.tokenIn), not
        // config.tokenIn.address — if a native-ETH sentinel was resolved to WETH above, the
        // stored row must match the signed struct (the orderHash binds order.tokenIn), else the
        // DB row and the on-chain order would disagree. Mirrors [CHORE-DCA-PRELAUNCH-FIXES Fix 2].
        tokenIn: order.tokenIn,
        tokenOut: config.tokenOut.address,
        amountIn: config.amountIn,
        minAmountOut: config.minAmountOut,
        targetPrice: config.targetPrice,
        priceFeed: config.priceFeed,
        priceCondition: config.condition === PriceCondition.ABOVE ? 'above' : 'below',
        expiry: new Date(Number(order.expiry) * 1000),
        nonce: Number(order.nonce),
        router: config.router,
        // [CHORE-DCA-PRELAUNCH-FIXES Fix 2] Persist EXACTLY what was signed — the frozen
        // struct is canonical (the orderHash binds it). Use the struct's dca values (which
        // already applied the 0n/1n defaults) instead of re-deriving a different `?? null`
        // default here, so the stored row can't disagree with the signed struct.
        dcaInterval: Number(order.dcaInterval),
        dcaTotal: Number(order.dcaTotal),
        signature,
        orderData: {
          owner: order.owner,
          tokenIn: order.tokenIn,
          tokenOut: order.tokenOut,
          amountIn: order.amountIn.toString(),
          minAmountOut: order.minAmountOut.toString(),
          // [SPRINT-V3-P2] Persisted ONLY for a v3 order — its presence in the stored order_data
          // JSON is what the keeper uses to route v2 vs v3 (dual-executor migration, commit 4).
          ...(order.maxSlippageBps !== undefined ? { maxSlippageBps: order.maxSlippageBps } : {}),
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
        tokenInSymbol,
        tokenOutSymbol: config.tokenOut.symbol,
        tokenInDecimals,
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
  }, [pendingOrder, address, chainId, orderExecutor, signTypedDataAsync, refetchNonce])

  // [SPRINT-9U U2] Cancel a pending review without signing (modal "Cancel").
  const clearPendingOrder = useCallback(() => setPendingOrder(null), [])

  // ── [CANCEL-REVIEW] Cancel order = Phase A: FREEZE the cancel plan for review (NO tx/signature) ──
  const cancelOrder = useCallback(async (orderId: string) => {
    if (!address) return
    const order = orders.find(o => o.id === orderId)
    if (!order) return

    // [SPRINT-V3-P2] v3 cancel/invalidate wiring is OUT OF SCOPE for this sprint (flagged in
    // FEEDBACK — deferred to a follow-up). This hook's on-chain cancelOrder/invalidateNonces calls
    // still target the v2 executor+ABI unconditionally below; sending a v3 order's struct there
    // would compute the WRONG hash (different typehash) and either no-op against v2 or, worse,
    // leave the Supabase row marked cancelled while the real v3 order stays live on-chain. Refuse
    // explicitly rather than silently mis-cancelling. Unreachable today (v3 is fail-closed
    // everywhere, so no v3 order can exist), but must not regress once v3 is deployed without
    // this wiring being extended first.
    if (order.order.maxSlippageBps !== undefined) {
      setLatestEvent({
        type: 'order_error',
        orderId,
        error: 'Cancelling v3 orders is not yet supported in this build — contact support.',
      })
      return
    }

    try {
      // Reconstruct the order struct with proper BigInt types (may be strings from localStorage).
      // This FROZEN struct is the exact cancelOrder() tx argument confirmCancel sends 1:1 — the
      // review modal renders from it, so modal == executed payload.
      const o = order.order
      const orderStruct: OnChainOrder = {
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
        routerDataHash: (o.routerDataHash || '0x0000000000000000000000000000000000000000000000000000000000000000') as `0x${string}`,  // [C-01]
        dcaInterval: BigInt(o.dcaInterval.toString()),
        dcaTotal: BigInt(o.dcaTotal.toString()),
      }

      // Re-calling cancelOrder overwrites the frozen plan → re-review. chainId is the ACTIVE
      // chain (chain-agnostic — ready for the Base order engine), captured for the confirm-time
      // re-check.
      setPendingCancel({ action: 'cancel', orderId, order, orderStruct, chainId, account: address })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message.slice(0, 120) : 'Cancel failed'
      setLatestEvent({ type: 'order_error', orderId, error: errorMsg })
    }
  }, [address, orders, chainId])

  // ── [CANCEL-REVIEW] Cancel ALL = Phase A: FREEZE the invalidate plan for review (NO tx) ──
  const cancelAllOrders = useCallback(async () => {
    if (!address) return
    const nonce = currentNonce !== undefined ? BigInt(currentNonce.toString()) : 0n
    const invalidated = currentInvalidatedNonce !== undefined ? BigInt(currentInvalidatedNonce.toString()) : 0n
    // newNonce must be > invalidatedNonces[user] AND should cover all current orders.
    // FROZEN here — confirmCancel sends exactly this value (no recompute after review).
    const newNonce = (nonce > invalidated ? nonce : invalidated) + 1n

    // [SPRINT-V3-P2] invalidateNonces() is a v2-only on-chain call (and v3's bitmap nonce isn't
    // even consumed by DCA — see the contract). Exclude v3 orders so cancel-all never marks a
    // still-live v3 order 'cancelled' in Supabase without actually invalidating it on-chain
    // (mirrors the single-order guard above). Unreachable today (v3 fail-closed everywhere).
    const affectedOrders = orders.filter(o =>
      (o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled') &&
      o.order.maxSlippageBps === undefined
    )

    setPendingCancel({ action: 'invalidate', newNonce, affectedOrders, chainId, account: address })
  }, [address, orders, currentNonce, currentInvalidatedNonce, chainId])

  // ── [CANCEL-REVIEW] Phase B: execute the FROZEN plan (reachable ONLY via the review modal) ──
  const confirmCancel = useCallback(async () => {
    const p = pendingCancel
    if (!p || !address) return
    // [9R defense] Reject a review built under a different chain/account than the one now connected.
    // The reset effects also clear it; this holds the invariant synchronously, independent of timing.
    if (p.chainId !== chainId || p.account.toLowerCase() !== address.toLowerCase()) {
      setPendingCancel(null)
      return
    }
    setPendingCancel(null) // consume the review (also serialises double-confirms)

    // [CHORE-ORDER-EXEC-PREP A] Fail-closed: no OrderExecutor on this chain → no on-chain cancel/
    // invalidate (and getOrderExecutorDomain would throw). On such chains no order could have been
    // created, so this is defensive; it also narrows `orderExecutor` to non-null below.
    if (!orderExecutor) {
      setLatestEvent({ type: 'order_error', orderId: crypto.randomUUID(), error: `Conditional orders are not available on chain ${chainId}.` })
      return
    }

    if (p.action === 'cancel') {
      const { orderId, order, orderStruct } = p
      try {
        // Cancel on-chain — contract verifies msg.sender == order.owner, then marks hash as
        // cancelled. Sends the FROZEN struct the user just reviewed, 1:1.
        await writeContractAsync({
          address: orderExecutor,
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
        // Domain uses the ACTIVE chainId (chain-agnostic, [H-05]).
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
      return
    }

    // p.action === 'invalidate'
    try {
      await writeContractAsync({
        address: orderExecutor,
        abi: ORDER_EXECUTOR_ABI,
        functionName: 'invalidateNonces',
        args: [p.newNonce], // the FROZEN nonce the user reviewed
      })

      // Mark all reviewed orders as cancelled in Supabase + local state.
      // [FULL-H-01] The PATCH endpoint now requires an EIP-712 CancelOrder
      // signature, so each per-order Supabase sync must be signed too — without
      // this the rows would stay 'active' in Supabase while the chain + local
      // UI show 'cancelled' (DB/chain divergence). One signature per reviewed
      // order; declined signatures are swallowed (on-chain invalidateNonces is
      // authoritative regardless).
      for (const order of p.affectedOrders) {
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

      // Mark exactly the REVIEWED set locally — the UI matches what the modal showed.
      const affectedIds = new Set(p.affectedOrders.map(o => o.id))
      setOrders(prev => prev.map(o =>
        affectedIds.has(o.id)
          ? { ...o, status: 'cancelled' as AutonomousOrderStatus }
          : o
      ))

      setLatestEvent({ type: 'order_cancelled', orderId: 'all' })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message.slice(0, 120) : 'Cancel all failed'
      setLatestEvent({ type: 'order_error', orderId: 'all', error: errorMsg })
    }
  }, [pendingCancel, address, chainId, orderExecutor, writeContractAsync, signTypedDataAsync])

  // [CANCEL-REVIEW] Dismiss a pending cancel review without executing (modal "Keep order(s)").
  const clearPendingCancel = useCallback(() => setPendingCancel(null), [])

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

  // [AUDIT-W6 / W6-M-01] Explicit user retry after a rejected read-signature
  // prompt: forget the session denial, sign, and reload the list.
  const requestOrdersReadAuth = useCallback(async () => {
    if (!address) return
    retryOrdersReadAuth(address)
    const outcome = await ensureOrdersReadAuth(address, (typed) =>
      signTypedDataAsync(typed as Parameters<typeof signTypedDataAsync>[0]),
    )
    if (outcome !== 'ok') return
    setReadAuthDenied(false)
    try {
      const rows = await fetchUserOrders(address)
      if (rows.length > 0) {
        const dismissed = getDismissedOrderIds()
        setOrders(rows.map(rowToOrder).filter(o => !dismissed.includes(o.id)))
      }
    } catch {
      /* the poll will pick the list up on its next tick */
    }
  }, [address, signTypedDataAsync])

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
    // [W6-M-01] Active-order reads are signature-gated; see requestOrdersReadAuth.
    readAuthDenied,
    requestOrdersReadAuth,
    currentNonce: currentNonce ? BigInt(currentNonce.toString()) : 0n,
    createOrder,
    // [SPRINT-9U U2] EIP-712 review gate
    pendingOrder,
    confirmOrder,
    clearPendingOrder,
    // [CANCEL-REVIEW] cancel/invalidate review gate (cancelOrder/cancelAllOrders only FREEZE)
    pendingCancel,
    confirmCancel,
    clearPendingCancel,
    cancelOrder,
    cancelAllOrders,
    removeOrder,
  }
}
