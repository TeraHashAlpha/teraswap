'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import TokenSelector from './TokenSelector'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import OrderReviewModal from './OrderReviewModal'
import OrderCancelReviewModal from './OrderCancelReviewModal'
import {
  OrderType,
  PriceCondition,
  DCA_INTERVAL_PRESETS,
  DCA_TOTAL_PRESETS,
  EXPIRY_PRESETS,
  getDefaultRouter,
  getChainlinkFeeds,
  MIN_ORDER_AMOUNT,
  dcaScheduleFitsExpiry,
} from '@/lib/order-engine'
import type { CreateOrderConfig } from '@/lib/order-engine'
import { DEFAULT_TOKENS, isNativeETH, type Token } from '@/lib/tokens'
import { getWrappedNative } from '@/lib/chains/registry'
import { findChainToken } from '@/lib/chains/tokens'
import { useTokenBalances } from '@/hooks/useTokenBalances'
import { useTokenBalance } from '@/hooks/useTokenBalance'
import { quickFillRaw, perChunkRaw } from '@/lib/dca-quick-fill'
import { checkRoute } from '@/lib/order-engine/check-route'
import { checkOracleCoverage } from '@/lib/order-engine/check-oracle'
import DCADashboard from './dca/DCADashboard'
import { playClick, playTouchMP3, playSwapConfirmMP3, playCancelOrderMP3, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import { NATIVE_ETH } from '@/lib/constants'
import BetaDisclaimer from './BetaDisclaimer'

// ── Map token symbols to Chainlink feeds ─────────────────
// Returns empty string if no feed found — callers must check before submitting.
function findPriceFeed(token: Token, chainId: number): string {
  const feeds = getChainlinkFeeds(chainId)
  const key = `${token.symbol}/USD`
  return feeds[key]?.address ?? ''
}

// [SPRINT-DCA-UNGATE] The DCA circuit-breaker (#201) returns an HTTP 403 whose message begins
// "New DCA orders are temporarily paused…". We can't poll a status endpoint (none exists — handle
// the 403), so we detect that error and switch the form into a calm paused state instead of
// surfacing a raw failure, disabling submit so the user isn't bounced again.
const DCA_PAUSED_RE = /temporarily paused/i

// ══════════════════════════════════════════════════════════
//  DCA PANEL — Autonomous DCA via TeraSwapOrderExecutor v2
// ══════════════════════════════════════════════════════════

export default function DCAPanel() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const {
    dcaOrders,
    activeOrders,
    historyOrders,
    latestEvent,
    isSubmitting,
    createOrder,
    pendingOrder,
    confirmOrder,
    clearPendingOrder,
    pendingCancel,
    confirmCancel,
    clearPendingCancel,
    cancelOrder,
    cancelAllOrders,
    removeOrder,
  } = useOrderEngine()

  const { toast } = useToast()

  // [SPRINT-DCA-UNGATE] Set when a freeze-403 is observed → paused UX + disabled submit.
  const [frozen, setFrozen] = useState(false)

  // Browser push notifications (fires when tab is in background)
  useOrderNotifications(latestEvent)

  // ── Sound effects + toasts on events ────────────────────
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'order_created') {
      stopWaitingSound()
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'DCA order placed', description: 'Your DCA is live — it will execute automatically on schedule.' })
    }
    if (latestEvent.type === 'dca_execution') {
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'DCA buy executed', description: `Buy #${latestEvent.executionNumber} completed autonomously.` })
    }
    if (latestEvent.type === 'order_filled') {
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'DCA complete!', description: 'All DCA buys executed successfully.', txHash: latestEvent.txHash, duration: 10000 })
      if (address) {
        trackTrade({
          type: 'dca_buy',
          wallet: address,
          tokenIn: '', tokenInAddress: '',
          tokenOut: '', tokenOutAddress: '',
          amountIn: '0', amountOut: '0',
          volumeUsd: 0,
          source: 'teraswap_order_engine',
          txHash: latestEvent.txHash || '',
        })
      }
    }
    if (latestEvent.type === 'order_cancelled') {
      playCancelOrderMP3()
      toast({ type: 'success', title: 'DCA order cancelled', description: 'Your DCA order has been cancelled on-chain.' })
    }
    if (latestEvent.type === 'order_error') {
      stopWaitingSound()
      playCancelOrderMP3()
      // [SPRINT-DCA-UNGATE] The freeze-403 is an operational pause, not a user error — show a calm
      // "temporarily paused" notice (no raw error) and latch the disabled state.
      if (DCA_PAUSED_RE.test(latestEvent.error || '')) {
        setFrozen(true)
        toast({ type: 'error', title: 'DCA temporarily paused', description: 'Only new DCA orders are paused — your existing ones keep running.' })
      } else {
        toast({ type: 'error', title: 'DCA order failed', description: latestEvent.error || 'Order could not be submitted.' })
      }
    }
  }, [latestEvent])

  // ── Tab state ──────────────────────────────────────────
  const [tab, setTab] = useState<'create' | 'positions'>('create')
  const activeDCA = dcaOrders.filter(o =>
    o.status === 'active' || o.status === 'executing' || o.status === 'partially_filled' || o.status === 'signing'
  )
  const historyDCA = dcaOrders.filter(o =>
    o.status === 'filled' || o.status === 'expired' || o.status === 'cancelled' || o.status === 'error'
  )

  return (
    <div className="w-full max-w-[calc(100vw-2rem)] sm:max-w-[460px]">
      {/* [SPRINT-9U U2] EIP-712 review — no DCA order is signed until the user confirms this frozen struct. */}
      {pendingOrder && <OrderReviewModal order={pendingOrder} onConfirm={confirmOrder} onCancel={clearPendingOrder} />}
      {/* [CANCEL-REVIEW] No cancel/invalidate executes until the user confirms this frozen plan. */}
      {pendingCancel && <OrderCancelReviewModal review={pendingCancel} onConfirm={confirmCancel} onCancel={clearPendingCancel} />}
      {/* Tab header */}
      <div className="mb-4 flex gap-1 rounded-xl border border-cream-08 bg-surface-secondary p-1">
        <button
          onClick={() => setTab('create')}
          className={`flex min-h-[44px] flex-1 items-center justify-center rounded-lg text-[13px] font-semibold transition-all ${
            tab === 'create'
              ? 'bg-cream-gold text-[#080B10]'
              : 'text-cream-50 hover:text-cream'
          }`}
        >
          New DCA
        </button>
        <button
          onClick={() => setTab('positions')}
          className={`flex min-h-[44px] flex-1 items-center justify-center rounded-lg text-[13px] font-semibold transition-all ${
            tab === 'positions'
              ? 'bg-cream-gold text-[#080B10]'
              : 'text-cream-50 hover:text-cream'
          }`}
        >
          Positions {activeDCA.length > 0 && `(${activeDCA.length})`}
        </button>
      </div>

      {tab === 'create' ? (
        <CreateDCAForm
          isConnected={isConnected}
          isSubmitting={isSubmitting}
          paused={frozen}
          onSubmit={createOrder}
        />
      ) : (
        <DCADashboard
          active={activeDCA}
          history={historyDCA}
          latestEvent={latestEvent}
          onCancel={cancelOrder}
          onCancelAll={cancelAllOrders}
          onRemove={removeOrder}
          onCreate={() => setTab('create')}
        />
      )}

      {/* Autonomous notice */}
      <div className="mt-3 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2 text-[11px] text-cream-50">
        <span className="font-semibold text-cream-gold">Autonomous execution</span> — DCA orders run 24/7 via Chainlink oracles. No browser required. Approve once, then sign — no infinite approvals, and the executor runs every buy automatically.
      </div>

      {/* Beta disclaimer */}
      <BetaDisclaimer />
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  CREATE DCA FORM
// ══════════════════════════════════════════════════════════

// [CHORE-DCA-WETH-INPUT] The chain's wrapped-native (WETH) as a rich Token, used as the
// DCA spend/input default and as the recovery target if the input ever became native ETH.
// Chain-aware (never hardcoded): getWrappedNative resolves mainnet/Base WETH, findChainToken
// returns the catalog Token (symbol/logo/decimals). Returns null only if a chain catalog
// lacks WETH (no supported chain does today) — the selector then shows "Select".
function wethFor(chainId: number): Token | null {
  return findChainToken(getWrappedNative(chainId), chainId)
}

function CreateDCAForm({
  isConnected,
  isSubmitting,
  paused,
  onSubmit,
}: {
  isConnected: boolean
  isSubmitting: boolean
  paused: boolean
  onSubmit: (config: CreateOrderConfig) => Promise<void>
}) {
  const chainId = useChainId()
  // [CHORE-DCA-WETH-INPUT] DCA spends an ERC-20: default the INPUT to the chain's WETH
  // (never native ETH). The OUTPUT still defaults to native ETH (contract unwraps WETH→ETH).
  const [tokenIn, setTokenIn] = useState<Token | null>(() => wethFor(chainId))
  const [tokenOut, setTokenOut] = useState<Token | null>(
    DEFAULT_TOKENS.find(t => t.symbol === 'ETH') ?? null
  )

  // [CHORE-DCA-WETH-INPUT] Keep the spend token pinned to the active chain's WETH. Also
  // recovers if the input ever became native ETH (it can't via the selector, which hides
  // it — this is belt-and-suspenders) so the signed struct's tokenIn is always an ERC-20.
  useEffect(() => {
    setTokenIn(prev => (prev && !isNativeETH(prev) ? prev : wethFor(chainId)))
  }, [chainId])

  // [CHORE-DCA-WETH-INPUT] Advisory guidance for the "holds only native ETH" case: if the
  // wallet has ETH but ~zero WETH, hint to wrap first. Native ETH is keyed under its sentinel
  // address; WETH under the chain's wrapped-native address. Non-blocking (they can wrap elsewhere).
  const { balances } = useTokenBalances()
  const hasNativeOnly = useMemo(() => {
    const weth = wethFor(chainId)
    const wethKey = weth?.address.toLowerCase()
    const nativeBal = balances.get(NATIVE_ETH.toLowerCase())?.raw ?? 0n
    const wethBal = wethKey ? (balances.get(wethKey)?.raw ?? 0n) : 0n
    return nativeBal > 0n && wethBal === 0n
  }, [balances, chainId])

  // [CHORE-DCA-UX-POLISH] Selected SPEND token balance from the chain-aware useTokenBalances map
  // (the CURATED catalog), keyed by the chain's wrapped-native address (never hardcoded).
  const mapEntry = useMemo(() => {
    const key = tokenIn && !isNativeETH(tokenIn) ? tokenIn.address.toLowerCase() : undefined
    return key ? balances.get(key) : undefined
  }, [balances, tokenIn])

  // [CHORE-DCA-UX-FIXES] Bug 1: imported/unverified spend tokens (e.g. ETHFI on Base) are NOT in the
  // curated useTokenBalances catalog, so the map has no entry and the line used to show "—" with the
  // presets disabled even when the wallet held the token. Read the SELECTED token's balance directly
  // (balanceOf) as a fallback — ONLY when the catalog has no entry, so curated tokens keep the
  // existing multicall path (no extra RPC, no #216 regression). `spendRaw` (bigint) drives the preset
  // math; `spendFormatted` is the display string.
  const directSpend = useTokenBalance(tokenIn, chainId, {
    enabled: isConnected && !!tokenIn && !isNativeETH(tokenIn) && !mapEntry,
  })
  const spendRaw = mapEntry?.raw ?? directSpend.raw ?? 0n
  const spendFormatted = mapEntry?.formatted ?? directSpend.formatted
  const hasSpendBalance = !!mapEntry || directSpend.hasValue
  const [totalDisplay, setTotalDisplay] = useState('')
  const [partsIdx, setPartsIdx] = useState(2) // default: 10 buys [chore/dca-ux-tweaks]
  const [intervalIdx, setIntervalIdx] = useState(4) // default: 1d (1h prepended shifted 1d 3→4) [chore/dca-ux-tweaks]
  const [expiryIdx, setExpiryIdx] = useState(3) // default: 30d
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [slippage, setSlippage] = useState('0.5')

  // [CHORE-DCA-UX-FIXES] Bug 3a: routability gate state. `hasImported` flags an imported/unverified
  // token on either side (the keeper has no curated route for thin tokens); `routeBlock` holds the
  // block reason after a failed pre-check; `checkingRoute` disables submit while the quote runs.
  const [routeBlock, setRouteBlock] = useState<string | null>(null)
  const [checkingRoute, setCheckingRoute] = useState(false)
  const hasImported = tokenIn?.category === 'Imported' || tokenOut?.category === 'Imported'

  // Monotonic id for routability checks: a token change (or a newer check) bumps it, so an in-flight
  // check whose pair was swapped mid-flight is dropped instead of blocking the now-selected pair.
  const routeCheckSeq = useRef(0)
  // Clear a stale block AND invalidate any in-flight check when the user changes either token.
  useEffect(() => { setRouteBlock(null); routeCheckSeq.current++ }, [tokenIn, tokenOut])

  // [chore/oracle-less-advisory] Detect whether the BOUGHT token has an independent
  // price oracle (Chainlink feed OR DefiLlama coverage) on the active chain. When it
  // does NOT, we render a NEUTRAL, informational heads-up (never blocks submission).
  // Debounced + seq-guarded like the routability check; fails OPEN so a transient
  // probe outage never shows a false note.
  const [oracleLess, setOracleLess] = useState(false)
  const oracleCheckSeq = useRef(0)
  useEffect(() => {
    setOracleLess(false)
    const seq = ++oracleCheckSeq.current
    const addr = tokenOut?.address
    if (!addr) return
    const t = setTimeout(async () => {
      const { hasOracle } = await checkOracleCoverage({ token: addr, chainId })
      if (oracleCheckSeq.current === seq) setOracleLess(!hasOracle)
    }, 400)
    return () => clearTimeout(t)
  }, [tokenOut, chainId])

  const parts = DCA_TOTAL_PRESETS[partsIdx]
  const interval = DCA_INTERVAL_PRESETS[intervalIdx]
  const expiry = EXPIRY_PRESETS[expiryIdx]

  // [CHORE-DCA-UX-POLISH] Balance line text: the resolved `formatted` string + symbol, or "—" while
  // disconnected / before any balance (catalog or direct read) has resolved. The raw bigint
  // (spendRaw) — not this display string — drives the preset math, so there is no float drift.
  const balanceDisplay = useMemo(() => {
    if (!isConnected || !hasSpendBalance) return '—'
    return `${spendFormatted ?? ''} ${tokenIn?.symbol ?? ''}`.trim()
  }, [isConnected, hasSpendBalance, spendFormatted, tokenIn])

  const presetsDisabled = !isConnected || spendRaw === 0n

  // [CHORE-DCA-UX-POLISH] Quick-fill: slice the raw balance in the smallest unit via quickFillRaw
  // (pure BigInt — never Number()/float; 100% returns the FULL balance unchanged), then formatUnits
  // once into the input. setTotalDisplay is the SAME setter the manual input writes.
  function fillPct(pct: 25 | 50 | 100) {
    if (!tokenIn || spendRaw === 0n) return
    setTotalDisplay(formatUnits(quickFillRaw(spendRaw, pct), tokenIn.decimals))
  }

  // [CHORE-DCA-UX-POLISH] Re-run the EXISTING per-chunk MIN_ORDER_AMOUNT floor after any fill
  // (preset or manual): per-chunk = floor(amountIn / parts) via perChunkRaw — the SAME split
  // useOrderEngine.createOrder enforces. When under-floor, surface the SAME hint copy the
  // submit-time guard uses. The hard pre-sign block still lives in createOrder — this is an
  // inline advisory, not a new gate.
  const underMin = useMemo(() => {
    if (!totalDisplay || !tokenIn || !parts) return false
    try {
      return perChunkRaw(parseUnits(totalDisplay, tokenIn.decimals), parts) < MIN_ORDER_AMOUNT
    } catch {
      return false
    }
  }, [totalDisplay, tokenIn, parts])

  // Derived values
  const perPart = useMemo(() => {
    const total = Number(totalDisplay)
    if (!parts || !total || parts <= 0) return '0'
    return (total / parts).toFixed(tokenIn?.decimals === 6 ? 2 : 6)
  }, [totalDisplay, parts, tokenIn])

  const totalDuration = useMemo(() => {
    if (!parts || parts <= 0) return ''
    const totalSec = parts * interval.seconds
    const hours = totalSec / 3600
    if (hours < 24) return `${hours.toFixed(0)} hours`
    const days = hours / 24
    if (days < 30) return `${days.toFixed(1)} days`
    return `${(days / 30).toFixed(1)} months`
  }, [parts, interval])

  // [chore/dca-resilience] Creation guard: a schedule that can't finish before
  // the order expires (interval × buys > expiry) is doomed to a partial,
  // eventually-failed order. Block submit + show a fix BEFORE the user signs.
  const scheduleFit = useMemo(
    () => dcaScheduleFitsExpiry({ intervalSeconds: interval.seconds, dcaTotal: parts, expirySeconds: expiry.seconds }),
    [interval, parts, expiry],
  )

  const canCreate = isConnected && tokenIn && tokenOut && Number(totalDisplay) > 0 && !isSubmitting && !paused && !checkingRoute && scheduleFit.fits

  async function handleCreate() {
    if (!canCreate || !tokenIn || !tokenOut) return
    // [chore/dca-resilience] Hard guard (defense-in-depth): never sign a DCA whose
    // schedule can't complete before it expires. canCreate already gates the
    // button, but this also blocks any programmatic call.
    if (!scheduleFit.fits) return
    setRouteBlock(null)
    startWaitingSound()

    let amountIn: string
    try {
      amountIn = parseUnits(totalDisplay, tokenIn.decimals).toString()
    } catch {
      stopWaitingSound()
      return // Invalid input (e.g. too many decimals)
    }

    // [CHORE-DCA-UX-FIXES] Bug 3a: routability pre-check for imported/unverified tokens. A thin
    // imported token (e.g. ETHFI) may have NO aggregator route on the target chain — the keeper would
    // revert executeOrder and the order would silently fail. Verify a route exists BEFORE approve/sign
    // and BLOCK if none. Scoped to imported tokens so curated pairs keep the zero-latency happy path.
    // The check uses the per-chunk amount (what each execution actually swaps). checkRoute fails OPEN
    // on transient quote outages, so only a definitive "no route" blocks.
    if (hasImported) {
      const seq = ++routeCheckSeq.current // claim this check
      setCheckingRoute(true)
      let routable = true
      let reason: string | undefined
      try {
        const perChunk = perChunkRaw(BigInt(amountIn), parts)
        const result = await checkRoute({
          src: tokenIn.address,
          dst: tokenOut.address,
          amount: (perChunk > 0n ? perChunk : BigInt(amountIn)).toString(),
          srcDecimals: tokenIn.decimals,
          dstDecimals: tokenOut.decimals,
          chainId,
        })
        routable = result.routable
        reason = result.reason
      } finally {
        setCheckingRoute(false)
      }
      // Drop a stale result if the user changed the pair (or started a newer check) mid-flight —
      // never block/sign the now-selected pair on a check that ran against the old one.
      if (routeCheckSeq.current !== seq) {
        stopWaitingSound()
        return
      }
      if (!routable) {
        stopWaitingSound()
        setRouteBlock(reason ?? 'No swap route found for this pair on this network.')
        return
      }
    }

    // minAmountOut = 1 wei for DCA — cannot be 0 (contract reverts with InvalidMinOutput).
    // Actual slippage protection is handled per-fill by the executor's swap route.
    const minAmountOut = '1'

    // DCA uses priceFeed = address(0) — the contract skips the Chainlink price check
    // entirely, executing on schedule at any price. This avoids MAX_STALENESS rejections
    // (contract has 300s staleness vs Chainlink's 3600s heartbeat).
    const priceFeed = '0x0000000000000000000000000000000000000000'

    const config: CreateOrderConfig = {
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      amountIn,
      minAmountOut,
      orderType: OrderType.DCA,
      condition: PriceCondition.ABOVE, // Unused when priceFeed = address(0)
      targetPrice: '0', // Unused when priceFeed = address(0)
      priceFeed, // address(0) = no price condition (DCA executes on schedule)
      expirySeconds: expiry.seconds,
      router: getDefaultRouter(chainId).address, // Best aggregated price
      dcaInterval: interval.seconds,
      dcaTotal: parts,
    }

    await onSubmit(config)
    setTotalDisplay('')
  }

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      <h3 className="mb-4 text-[15px] font-semibold text-cream">
        Dollar Cost Averaging
      </h3>

      {/* Sell token */}
      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Total to spend
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-primary px-3 py-2.5">
          <TokenSelector
            selected={tokenIn}
            onSelect={setTokenIn}
            disabledAddress={tokenOut?.address}
            hideNativeInput
          />
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={totalDisplay}
            // [BUGFIX] Prevent multiple decimal points
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              const parts = v.split('.')
              setTotalDisplay(parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : v)
            }}
            className="flex-1 bg-transparent text-right text-lg font-semibold text-cream outline-none placeholder:text-cream-20"
          />
        </div>
        {/* [CHORE-DCA-UX-POLISH] Balance line + 25/50/100% quick-fill for the spend token (WETH). */}
        <div className="mt-1 flex items-center justify-between">
          <span data-testid="dca-spend-balance" className="text-[11px] text-cream-35">
            Balance: {balanceDisplay}
          </span>
          <div className="flex gap-1">
            {([25, 50, 100] as const).map(p => (
              <button
                key={p}
                type="button"
                disabled={presetsDisabled}
                onClick={() => { playClick(); fillPct(p) }}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-cream-08 px-2 text-[11px] text-cream-35 transition-colors enabled:hover:text-cream-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {p}%
              </button>
            ))}
          </div>
        </div>
        {/* [CHORE-DCA-UX-POLISH] Re-validate the per-chunk MIN_ORDER_AMOUNT floor and surface the
            SAME hint copy the submit-time guard uses (useOrderEngine.ts). The hard block stays in
            createOrder — this is an inline advisory after a preset/manual fill lands under-floor. */}
        {underMin && (
          <p className="mt-1 text-[11px] text-amber-300">
            Each DCA buy must be at least {Number(MIN_ORDER_AMOUNT).toLocaleString()} base units (the on-chain minimum). Increase the total amount or reduce the number of buys.
          </p>
        )}
        {/* [CHORE-DCA-WETH-INPUT] Advisory hint when the wallet holds native ETH but no WETH. */}
        {hasNativeOnly && (
          <p className="mt-1 text-[11px] text-cream-35">
            DCA spends an ERC-20 token. You hold native ETH — wrap it to WETH first to start a DCA.
          </p>
        )}
        {/* [CHORE-DCA-UX-FIXES] Bug 3a: imported-token heads-up + routability block. We verify a swap
            route exists (per-chunk) before letting the order be signed, since thin imported tokens may
            have no aggregator route and would silently fail at keeper execution. */}
        {hasImported && !routeBlock && (
          <p className="mt-1 text-[11px] text-amber-300" data-testid="dca-imported-notice">
            ⚠️ Imported token — limited liquidity. We&apos;ll verify a swap route before placing the order.
          </p>
        )}
        {routeBlock && (
          <p className="mt-1 text-[11px] text-red-400" data-testid="dca-route-block">{routeBlock}</p>
        )}
      </div>

      {/* Arrow */}
      <div className="my-2 flex justify-center">
        <div className="rounded-full border border-cream-08 bg-surface-primary p-1.5 text-cream-50">
          ↓
        </div>
      </div>

      {/* Buy token */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Buy
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-primary px-3 py-2.5">
          <TokenSelector
            selected={tokenOut}
            onSelect={setTokenOut}
            disabledAddress={tokenIn?.address}
          />
          <span className="flex-1 text-right text-sm text-cream-35">
            Best price at each execution
          </span>
        </div>
        {/* [chore/oracle-less-advisory] NEUTRAL, informational note (plain text +
            bold only — deliberately NO warning colours/icons/callout) shown when
            the bought token has no independent price oracle. Informational only —
            it never disables submit. */}
        {oracleLess && tokenOut && (
          <p className="mt-2 text-[11px] leading-relaxed text-cream-50" data-testid="dca-oracle-note">
            <span className="font-semibold text-cream">{tokenOut.symbol} has no price oracle</span>{' '}
            — fills use the best available DEX route, so the execution price depends on on-chain liquidity.
          </p>
        )}
      </div>

      {/* Number of parts */}
      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Number of Buys
        </label>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {DCA_TOTAL_PRESETS.map((n, idx) => (
            <button
              key={n}
              onClick={() => { setPartsIdx(idx); playClick() }}
              className={`flex min-h-[44px] items-center justify-center rounded-lg border text-[13px] font-semibold transition-all ${
                partsIdx === idx
                  ? 'border-cream-gold bg-cream-gold/10 text-cream'
                  : 'border-cream-08 text-cream-35 hover:border-cream-15 hover:text-cream-50'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Interval */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Interval
        </label>
        <div className="flex gap-2 flex-wrap">
          {DCA_INTERVAL_PRESETS.map((iv, idx) => (
            <button
              key={iv.seconds}
              onClick={() => { setIntervalIdx(idx); playClick() }}
              className={`inline-flex min-h-[44px] items-center justify-center rounded-lg border px-3 text-[12px] font-semibold transition-all ${
                intervalIdx === idx
                  ? 'border-cream-gold bg-cream-gold/10 text-cream'
                  : 'border-cream-08 text-cream-35 hover:border-cream-15 hover:text-cream-50'
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>
      </div>

      {/* [CHORE-DCA-UX-POLISH] Order expiry — always visible (moved out of Advanced), alongside
          Number of Buys / Interval. State/values/behaviour unchanged; only the render moved. */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Order expiry
        </label>
        <div className="flex gap-2 flex-wrap">
          {EXPIRY_PRESETS.map((e, idx) => (
            <button
              key={e.seconds}
              onClick={() => { setExpiryIdx(idx); playClick() }}
              className={`inline-flex min-h-[44px] items-center justify-center rounded-lg border px-3 text-[12px] font-semibold transition-all ${
                expiryIdx === idx
                  ? 'border-cream-gold bg-cream-gold/10 text-cream'
                  : 'border-cream-08 text-cream-35 hover:border-cream-15 hover:text-cream-50'
              }`}
            >
              {e.label}
            </button>
          ))}
        </div>
        {/* [chore/dca-resilience] Creation guard: interval × buys can't complete
            before this expiry → block submit (canCreate) and explain the fix. */}
        {!scheduleFit.fits && (
          <p className="mt-2 text-[11px] text-red-400" data-testid="dca-expiry-block">
            {scheduleFit.reason}
          </p>
        )}
      </div>

      {/* Summary */}
      {Number(totalDisplay) > 0 && (
        <div className="mb-4 rounded-xl border border-cream-08 bg-surface-primary p-3 text-[13px]">
          <div className="flex justify-between text-cream-50">
            <span>Per buy</span>
            <span className="text-cream font-medium">{perPart} {tokenIn?.symbol}</span>
          </div>
          <div className="mt-1 flex justify-between text-cream-50">
            <span>Total duration</span>
            <span className="text-cream font-medium">{totalDuration}</span>
          </div>
          <div className="mt-1 flex justify-between text-cream-50">
            <span>Execution</span>
            <span className="text-cream font-medium">Every {interval.label}</span>
          </div>
          <div className="mt-1 flex justify-between text-cream-50">
            <span>Expires</span>
            <span className="text-cream font-medium">{expiry.label}</span>
          </div>
          <div className="mt-2 border-t border-cream-08 pt-2 text-[11px] text-cream-35">
            Each buy routes through 11 DEX sources via 1inch aggregation.
            Orders execute autonomously — no browser needed.
          </div>
        </div>
      )}

      {/* Advanced */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="mb-3 inline-flex min-h-[44px] items-center text-xs text-cream-35 hover:text-cream-50 transition-colors"
      >
        {showAdvanced ? '▾' : '▸'} Advanced settings
      </button>
      {showAdvanced && (
        <div className="mb-4 space-y-3">
          {/* Slippage */}
          <div className="rounded-xl border border-cream-08 bg-surface-primary p-3">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
              Slippage tolerance
            </label>
            <div className="flex gap-2">
              {['0.3', '0.5', '1.0'].map(s => (
                <button
                  key={s}
                  onClick={() => setSlippage(s)}
                  className={`inline-flex min-h-[44px] items-center justify-center rounded-lg border px-3 text-[12px] font-semibold transition-all ${
                    slippage === s
                      ? 'border-cream-gold bg-cream-gold/10 text-cream'
                      : 'border-cream-08 text-cream-35 hover:text-cream-50'
                  }`}
                >
                  {s}%
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* [SPRINT-DCA-UNGATE] Freeze (403) notice — submit is also disabled via canCreate. */}
      {paused && (
        <div className="mb-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-300">
          <span className="font-semibold">DCA temporarily paused.</span> New DCA orders are paused right now — existing orders are unaffected and you can still cancel them.
        </div>
      )}

      {/* Create button */}
      {!isConnected ? (
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      ) : (
        <button
          disabled={!canCreate}
          // [BUGFIX] await async handleCreate to catch errors properly
          onClick={async () => { playTouchMP3(); await handleCreate() }}
          className={`w-full rounded-xl py-3 text-[14px] font-bold uppercase tracking-wider transition-all ${
            canCreate
              ? 'bg-gradient-to-r from-gold to-gold-light text-[#080B10] hover:brightness-110 active:scale-[0.98]'
              : 'bg-cream-08 text-cream-20 cursor-not-allowed'
          }`}
        >
          {isSubmitting
            ? 'Signing order...'
            : checkingRoute
            ? 'Checking route…'
            : paused
            ? 'DCA temporarily paused'
            : !tokenIn || !tokenOut
            ? 'Select Tokens'
            : Number(totalDisplay) <= 0
            ? 'Enter Amount'
            : `Start DCA — ${parts} buys over ${totalDuration}`
          }
        </button>
      )}
    </div>
  )
}
