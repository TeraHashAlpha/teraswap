'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import TokenSelector from './TokenSelector'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import OrderReviewModal from './OrderReviewModal'
import OrderCancelReviewModal from './OrderCancelReviewModal'
// [FIX-DCA-NOFEED-CONSENT] Plain-language consent gate for a no-price-feed output token.
import NoFeedConsentModal from './NoFeedConsentModal'
// [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED L-2] resolveFeed, NOT getChainlinkFeed — see
// outputHasNoResolvableFeed below for why the direct-only lookup was wrong post-ADR-018.
import { resolveFeed } from '@/lib/chains/chainlink-feeds'
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
  fillUsd,
  APPROX_PRICES,
  DCA_CUSTOM_BUYS_MIN,
  DCA_CUSTOM_BUYS_MAX,
  DCA_CUSTOM_INTERVAL_NUMBER_MIN,
  DCA_CUSTOM_INTERVAL_NUMBER_MAX,
  clampCustomBuys,
  clampCustomIntervalNumber,
  customIntervalSeconds,
  deriveCustomExpirySeconds,
  getDcaMinChunkUsd,
  applyDcaMinChunkGuard,
  // [SPRINT-V3-P2 / ADR-013 §1] v3 signing — fail-closed while getOrderExecutorV3(chainId) is null.
  getOrderExecutorV3,
  MAX_ORDER_SLIPPAGE_BPS,
  DEFAULT_MAX_SLIPPAGE_BPS,
  deriveSigningMinAmountOut,
  type DcaCustomIntervalUnit,
} from '@/lib/order-engine'
import type { CreateOrderConfig } from '@/lib/order-engine'
import { DEFAULT_TOKENS, isNativeETH, type Token } from '@/lib/tokens'
import { getWrappedNative, getChainConfig } from '@/lib/chains/registry'
import { findChainToken } from '@/lib/chains/tokens'
import { useTokenBalances } from '@/hooks/useTokenBalances'
import { useTokenBalance } from '@/hooks/useTokenBalance'
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice'
// [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] The SAME classifier the swap flow gates on. Imported
// read-only — no second, parallel price decision is written in this component.
import { evaluatePriceGate, type PriceGateReason } from '@/lib/price-gate'
import type { PriceCheck } from '@/lib/chainlink'
import { fetchDefiLlamaPrice } from '@/lib/defillama'
import { quickFillRaw, perChunkRaw, formatMinBuyMessage } from '@/lib/dca-quick-fill'
import { checkRoute } from '@/lib/order-engine/check-route'
import { checkOracleCoverage } from '@/lib/order-engine/check-oracle'
import DCADashboard from './dca/DCADashboard'
import { playClick, playTouchMP3, playSwapConfirmMP3, playCancelOrderMP3, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import { NATIVE_ETH, DEPEG_CONSENT_TOLERANCE } from '@/lib/constants'
import BetaDisclaimer from './BetaDisclaimer'
// [FEAT-DEPEG-GATE-ORDER-CREATION] The same, twice-audited cbETH depeg circuit-breaker SwapBox
// uses — wired here so a multi-day autonomous DCA cannot be started into a depegged/unverifiable
// pair with zero signal. Read-only reuse: neither the hook nor its thresholds are modified.
import { useDepegCheck } from '@/hooks/useDepegCheck'

// ── Map token symbols to Chainlink feeds ─────────────────
// Returns empty string if no feed found — callers must check before submitting.
function _findPriceFeed(token: Token, chainId: number): string {
  const feeds = getChainlinkFeeds(chainId)
  const key = `${token.symbol}/USD`
  return feeds[key]?.address ?? ''
}

// [SPRINT-DCA-UNGATE] The DCA circuit-breaker (#201) returns an HTTP 403 whose message begins
// "New DCA orders are temporarily paused…". We can't poll a status endpoint (none exists — handle
// the 403), so we detect that error and switch the form into a calm paused state instead of
// surfacing a raw failure, disabling submit so the user isn't bounced again.
const DCA_PAUSED_RE = /temporarily paused/i

// ── [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] DCA oracle gate ───
/**
 * This panel used to read `useChainlinkPrice(...).chainlinkPrice` and DISCARD both
 * `oracleIntegrityFailed` and `oracleReadFailed` — the same fail-open class already closed in the
 * swap flow. The discarded verdict was not cosmetic here: that price is the reference
 * `deriveSigningMinAmountOut` derives the per-buy `minAmountOut` floor from, so a feed we could not
 * verify became a floor the user then SIGNED — and, for the stale / `answeredInRound < roundId`
 * cases, `chainlinkPrice` comes back POPULATED alongside `oracleIntegrityFailed: true`, so the bad
 * number was used directly rather than merely leaving a gap.
 *
 * The decision is NOT re-implemented. Each leg is classified by the same `evaluatePriceGate` the
 * swap flow uses; this function only (a) aggregates the two legs — a DCA reference price is the
 * RATIO priceIn/priceOut, so either leg failing poisons it — and (b) carries the failing leg's own
 * message up, since `useChainlinkPrice` already writes precise per-case copy.
 *
 * Reachability, stated because it bounds what the UI must say: both legs are read with
 * `executionPriceUsd = null`, so `useChainlinkPrice` never reaches `evaluateDeviation` and never
 * returns a warn/danger DEVIATION level. Only `'block'/'oracle-integrity'` and `'ok'` are reachable
 * today. `'extreme-deviation'` and `'consent'` are still routed correctly rather than assumed away:
 * if a future change gives this call site a real execution price, an extreme deviation must block
 * under its OWN reason (so the UI says "price moved", not "we could not verify"), and informed
 * consent must not silently harden into an unexplainable block.
 */
export interface DcaOracleGate {
  /** true ⇒ no DCA order may be created, AND no non-oracle price may substitute for the feed. */
  blocked: boolean
  /** Which `evaluatePriceGate` reason blocked — the UI branches on this for accurate copy. */
  reason: PriceGateReason
  /** The failing leg's own message; null when nothing blocked. */
  detail: string | null
}

export function evaluateDcaOracleGate(spend: PriceCheck, buy: PriceCheck): DcaOracleGate {
  for (const check of [spend, buy]) {
    const gate = evaluatePriceGate(check)
    if (gate.mode === 'block') {
      return { blocked: true, reason: gate.reason, detail: check.message }
    }
  }
  return { blocked: false, reason: 'none', detail: null }
}

/**
 * [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED L-2] Does the OUTPUT token have NO price source of any shape on
 * this chain? This is the single signal behind the "this token has no Chainlink price feed" consent
 * modal, and it must answer the same question `useChainlinkPrice` answers — otherwise the panel
 * demands consent for a missing feed while the hook is pricing the token perfectly well, and the
 * signing floor the user is being warned about is in fact oracle-derived.
 *
 * It used to call `getChainlinkFeed`, which only knows DIRECT token/USD feeds. Post-ADR-018 a token
 * may instead resolve COMPOSED (base × quote) — Base cbETH is exactly that: no direct cbETH/USD
 * entry, but a verified cbETH/ETH × ETH/USD pair that the hook reads and that
 * `deriveSigningMinAmountOut` derives the per-buy floor from. The direct-only lookup returned null
 * for it, so cbETH fired a "no feed" consent modal that was simply false.
 *
 * `resolveFeed` is the SAME resolver the hook uses, so the two cannot disagree. The safe direction is
 * preserved and is in fact stricter: `resolveFeed` returns null both when nothing is configured AND
 * when a configured leg has no declared FEED_EXPECTATIONS identity (it fails closed rather than
 * trusting an address with no declared identity) — either way this returns true and the user still
 * reaches the consent modal. No threshold, source, or fallback is introduced here.
 */
export function outputHasNoResolvableFeed(token: Token | null, chainId: number): boolean {
  return !!token && resolveFeed(token.address, chainId) === null
}

// ══════════════════════════════════════════════════════════
//  DCA PANEL — Autonomous DCA via TeraSwapOrderExecutor v2
// ══════════════════════════════════════════════════════════

export default function DCAPanel() {
  const { address, isConnected } = useAccount()
  const _chainId = useChainId()
  const {
    dcaOrders,
    activeOrders: _activeOrders,
    historyOrders: _historyOrders,
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

  // [FIX-DCA-NOFEED-CONSENT] Whether the OUTPUT token has no Chainlink feed on this chain — the
  // single signal that gates the consent modal. Feed-covered tokens never trigger it.
  // [L-2] Resolved via the hook's own resolver, so a COMPOSED feed counts as having a feed.
  const noFeedOutput = useMemo(
    () => outputHasNoResolvableFeed(tokenOut, chainId),
    [tokenOut, chainId],
  )
  const [showNoFeedModal, setShowNoFeedModal] = useState(false)
  // Tracks WHICH token address consent was last given for (not a bare boolean), so switching to a
  // different output token — or simply comparing against the currently selected one — naturally
  // requires asking again, with no separate reset effect needed.
  const [noFeedConsentGivenFor, setNoFeedConsentGivenFor] = useState<string | null>(null)
  const noFeedConsentGiven = !!tokenOut && noFeedConsentGivenFor === tokenOut.address

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

  // [CHORE-DCA-CUSTOM-PERIODS] Custom buys/interval — off by default (presets unchanged).
  const [customMode, setCustomMode] = useState(false)
  const [customBuysRaw, setCustomBuysRaw] = useState(10)
  const [customIntervalNumRaw, setCustomIntervalNumRaw] = useState(1)
  const [customIntervalUnit, setCustomIntervalUnit] = useState<DcaCustomIntervalUnit>('days')
  // Displayed/derived values are ALWAYS clamped — an in-flight keystroke (e.g. "1" while
  // typing "15") can never leave the clamp, so nothing invalid is ever computed downstream
  // even if the input's onBlur hasn't fired yet.
  const customBuysClamped = clampCustomBuys(customBuysRaw)
  const customIntervalNumClamped = clampCustomIntervalNumber(customIntervalNumRaw)
  const customInterval = {
    label: `${customIntervalNumClamped}${customIntervalUnit === 'hours' ? 'h' : 'd'}`,
    seconds: customIntervalSeconds(customIntervalNumRaw, customIntervalUnit),
  }

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

  // ── [SPRINT-V3-P2 / ADR-013 §1] v3 signing derivation — fail-closed, inert while unconfigured ──
  // v3Enabled is ONLY true once a real per-chain OrderExecutorV3 address is configured
  // (getOrderExecutorV3). It is null on every chain today, so every hook below still runs (Rules
  // of Hooks — always called) but is a no-op: minAmountOut stays the existing '1' v2 path in
  // handleSubmit until v3Enabled flips true on a real deployment.
  const v3Enabled = getOrderExecutorV3(chainId) !== null
  const [maxSlippageBps, setMaxSlippageBps] = useState(DEFAULT_MAX_SLIPPAGE_BPS)

  // Chainlink first (same hook the swap UI already uses for oracle display).
  // [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] The FULL PriceCheck is kept now — `.chainlinkPrice` alone
  // silently dropped the oracleIntegrityFailed / oracleReadFailed verdict on the floor.
  const oracleSpend = useChainlinkPrice(tokenIn?.address, null)
  const oracleBuy = useChainlinkPrice(tokenOut?.address, null)
  const chainlinkPriceIn = oracleSpend.chainlinkPrice
  const chainlinkPriceOut = oracleBuy.chainlinkPrice

  const oracleGate = evaluateDcaOracleGate(oracleSpend, oracleBuy)
  // Armed exactly where the oracle price is LOAD-BEARING — i.e. where the v3 derivation consumes
  // it. On the v2 path `minAmountOut` is the literal '1' and `priceFeed` is address(0), so the two
  // reads above feed nothing at all; blocking creation there would cost availability on every
  // ETH/USD RPC blip and buy no safety. This is NOT a narrowing in production: DCAPanel is only
  // ever rendered behind `isDcaLive(chainId)` (page.tsx), which itself requires
  // `getOrderExecutorV3(chainId) !== null` — the SAME condition as v3Enabled. Wherever a user can
  // reach this panel at all, this gate is armed; the v2 branch below is reachable only from tests.
  const oracleBlocked = v3Enabled && oracleGate.blocked
  // THE TRAP. This is the ONLY permission the non-oracle price sources may read. A Chainlink
  // integrity failure must not be rescued by DefiLlama, nor by the hardcoded APPROX_PRICES table
  // that sits behind it inside deriveSigningMinAmountOut. Falling back after the oracle refused
  // would launder a fail-closed state into a fail-open one — strictly worse than having no gate,
  // because the resulting floor would then LOOK price-derived while resting on a source the oracle
  // check never covered. Every consumer of a non-oracle price below is gated on this one bit: the
  // DefiLlama fetch effect, the `signingMin` preview, and `handleCreate`'s v3 derivation.
  const oracleFallbackAllowed = !oracleBlocked

  // DefiLlama fallback ONLY when v3 is enabled and Chainlink missed a leg — never fetched on the
  // (current, everywhere) v2 path, so this adds zero network traffic today.
  const [llamaPriceIn, setLlamaPriceIn] = useState<number | null>(null)
  const [llamaPriceOut, setLlamaPriceOut] = useState<number | null>(null)
  useEffect(() => {
    // [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] Second clause is the trap-closer: while the oracle gate
    // blocks, DefiLlama is never even ASKED, and any price it returned earlier in the session is
    // cleared — so a feed that degrades mid-session cannot leave a stale non-oracle price behind to
    // feed the derivation. A no-feed token is NOT this case: `evaluatePriceGate` returns 'ok' for
    // `oracleUnavailable`, so the fallback stays fully available where it is legitimate.
    if (!v3Enabled || !oracleFallbackAllowed) { setLlamaPriceIn(null); setLlamaPriceOut(null); return }
    let cancelled = false
    const slug = (() => { try { return getChainConfig(chainId).slug } catch { return 'ethereum' } })()
    if (chainlinkPriceIn == null && tokenIn) {
      fetchDefiLlamaPrice(tokenIn.address, slug).then(p => { if (!cancelled) setLlamaPriceIn(p?.price ?? null) }).catch(() => { if (!cancelled) setLlamaPriceIn(null) })
    } else {
      setLlamaPriceIn(null)
    }
    if (chainlinkPriceOut == null && tokenOut) {
      fetchDefiLlamaPrice(tokenOut.address, slug).then(p => { if (!cancelled) setLlamaPriceOut(p?.price ?? null) }).catch(() => { if (!cancelled) setLlamaPriceOut(null) })
    } else {
      setLlamaPriceOut(null)
    }
    return () => { cancelled = true }
  }, [v3Enabled, oracleFallbackAllowed, tokenIn, tokenOut, chainlinkPriceIn, chainlinkPriceOut, chainId])

  // Live preview of the amount that WOULD be signed, for the "derived floor" display.
  const liveAmountInRaw = useMemo(() => {
    if (!v3Enabled || !tokenIn || !totalDisplay) return null
    try { return parseUnits(totalDisplay, tokenIn.decimals) } catch { return null }
  }, [v3Enabled, tokenIn, totalDisplay])

  const signingMin = useMemo(() => {
    // [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] No floor is PREVIEWED on a blocked oracle either. Without
    // this the panel would still render a confident "Signed floor per order: ≥ X" while creation is
    // blocked — showing the user a number we just refused to stand behind.
    if (!v3Enabled || oracleBlocked || !tokenIn || !tokenOut || liveAmountInRaw == null || liveAmountInRaw <= 0n) return null
    // [FIX-SIGNING-MIN-PRICE-INTEGRITY] APPROX_PRICES is NOT passed: a hardcoded table may not
    // price a signed on-chain minimum (INC-2026-08-07-001). An unpriceable leg now yields the
    // honest no-feed floor + decay warning. The parameters no longer exist, so this is enforced by
    // the compiler, not by this comment.
    return deriveSigningMinAmountOut({
      amountIn: liveAmountInRaw,
      srcDecimals: tokenIn.decimals,
      dstDecimals: tokenOut.decimals,
      maxSlippageBps,
      chainlinkPriceIn, chainlinkPriceOut,
      defiLlamaPriceIn: llamaPriceIn, defiLlamaPriceOut: llamaPriceOut,
    })
  }, [v3Enabled, oracleBlocked, tokenIn, tokenOut, liveAmountInRaw, maxSlippageBps, chainlinkPriceIn, chainlinkPriceOut, llamaPriceIn, llamaPriceOut])

  // [CHORE-DCA-CUSTOM-PERIODS req.2 min-chunk] Total spend in USD (APPROX_PRICES-priced
  // tokens only — null for anything unpriced, e.g. an imported token). Feeds the SC-02 dust
  // guard below; fails OPEN when unpriced (same posture fillUsd uses everywhere else), so the
  // per-chunk MIN_ORDER_AMOUNT base-unit floor (useOrderEngine.createOrder, untouched) stays
  // the universal backstop regardless of pricing.
  const totalUsd = useMemo(() => {
    if (!totalDisplay || !tokenIn) return null
    try {
      return fillUsd(parseUnits(totalDisplay, tokenIn.decimals).toString(), tokenIn.decimals, tokenIn.symbol)
    } catch {
      return null
    }
  }, [totalDisplay, tokenIn])

  // [FEAT-DEPEG-GATE-ORDER-CREATION] Same hook, same semantics as SwapBox: 'ok' when the pair has
  // no registered exchange-rate feed (the common case — creation proceeds), 'consent'/'block' when
  // checked and off-peg, 'unverified' when the check applies but could not be run, 'pending' while
  // in flight. Consent (like SwapBox's) is reset on a chain switch — a new chain is a new trade.
  const depegCheck = useDepegCheck(tokenIn?.address, tokenOut?.address)
  const [acceptedDepeg, setAcceptedDepeg] = useState<number | null>(null)
  useEffect(() => { setAcceptedDepeg(null) }, [chainId])
  const depegConsentNeeded = depegCheck.mode === 'consent'
  const depegAccepted = acceptedDepeg != null && depegCheck.divergence <= acceptedDepeg + DEPEG_CONSENT_TOLERANCE
  const depegConsentBlocking = depegConsentNeeded && !depegAccepted
  const depegHardBlocked = depegCheck.mode === 'block'
  const depegUnverified = depegCheck.mode === 'unverified'
  const depegBlocking = depegHardBlocked || depegConsentBlocking || depegUnverified

  const dcaMinChunkUsd = useMemo(() => getDcaMinChunkUsd(), [])
  const minChunkGuard = useMemo(
    () => customMode
      ? applyDcaMinChunkGuard({ totalUsd, requestedBuys: customBuysClamped, minChunkUsd: dcaMinChunkUsd })
      : { buys: customBuysClamped, warning: null as string | null, blocked: false },
    [customMode, totalUsd, customBuysClamped, dcaMinChunkUsd],
  )

  const parts = customMode ? minChunkGuard.buys : DCA_TOTAL_PRESETS[partsIdx]
  const interval = customMode ? customInterval : DCA_INTERVAL_PRESETS[intervalIdx]
  // [CHORE-DCA-CUSTOM-PERIODS req.2 expiry coherence] Custom mode auto-derives expiry
  // (interval*buys + buffer, capped at MAX_EXPIRY_DAYS) instead of a preset — see
  // deriveCustomExpirySeconds for why an over-long schedule naturally trips the EXISTING
  // scheduleFit gate below rather than needing a second hard-warn.
  const expiry = useMemo(() => {
    if (!customMode) return EXPIRY_PRESETS[expiryIdx]
    const seconds = deriveCustomExpirySeconds({ intervalSeconds: interval.seconds, buys: parts })
    const label = seconds < 86_400 ? `${Math.round(seconds / 3600)}h` : `${(seconds / 86_400).toFixed(1)}d`
    return { label, seconds }
  }, [customMode, expiryIdx, interval.seconds, parts])

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

  // [fix/dca-min-buy-copy] Human/USD-readable per-buy floor hint — the SAME formatter the
  // useOrderEngine.createOrder toast uses, so the inline warning and the toast never drift.
  // priceUsd reuses the SAME price source as totalUsd above (APPROX_PRICES via fillUsd),
  // failing OPEN to token-units-only copy (no fabricated USD) when the symbol is unpriced.
  const minBuyMessage = useMemo(() => {
    if (!underMin || !totalDisplay || !tokenIn || !parts) return null
    try {
      const totalRaw = parseUnits(totalDisplay, tokenIn.decimals)
      const priceUsd = APPROX_PRICES[(tokenIn.symbol || '').toUpperCase()] ?? null
      return formatMinBuyMessage({
        minBuyRaw: MIN_ORDER_AMOUNT,
        decimals: tokenIn.decimals,
        symbol: tokenIn.symbol,
        totalRaw,
        requestedBuys: parts,
        priceUsd,
      }).text
    } catch {
      return null
    }
  }, [underMin, totalDisplay, tokenIn, parts])

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

  const canCreate = isConnected && tokenIn && tokenOut && Number(totalDisplay) > 0 && !isSubmitting && !paused && !checkingRoute && scheduleFit.fits && !minChunkGuard.blocked && !depegBlocking && !oracleBlocked

  async function handleCreate() {
    if (!canCreate || !tokenIn || !tokenOut) return
    // [chore/dca-resilience] Hard guard (defense-in-depth): never sign a DCA whose
    // schedule can't complete before it expires. canCreate already gates the
    // button, but this also blocks any programmatic call.
    if (!scheduleFit.fits) return
    // [CHORE-DCA-CUSTOM-PERIODS] Hard guard (defense-in-depth): never sign a dust DCA
    // (total too small to clear the per-buy minimum even at 1 buy).
    if (minChunkGuard.blocked) return
    // [FEAT-DEPEG-GATE-ORDER-CREATION] Hard guard (defense-in-depth): never sign a DCA into a
    // depegged or unverifiable pair. canCreate already gates the button; this also blocks any
    // programmatic call.
    if (depegBlocking) return
    // [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] Hard guard (defense-in-depth), same shape as the three
    // above: never sign a DCA whose per-buy floor would be derived from a price the oracle refused
    // to vouch for. canCreate already gates the button; this is what blocks a forced or programmatic
    // call, and it is what stops the v3 derivation below from reading llama/APPROX prices.
    if (oracleBlocked) return
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

    // [SPRINT-V3-P2 / ADR-013 §1] v3 signing: derive a REAL absolute minAmountOut (never '1')
    // from the reference price × (1 − maxSlippageBps), same formula the keeper's oracle floor
    // uses. Falls back to a fixed non-zero, non-price floor (still never '1') when no LIVE
    // reference price exists on either side — the ADR-013 owner-approved no-feed UX. v2
    // (v3Enabled=false, the case on every chain today) is completely unchanged: minAmountOut = '1',
    // no maxSlippageBps field, byte-identical to before this sprint.
    //
    // [FIX-SIGNING-MIN-PRICE-INTEGRITY / INC-2026-08-07-001] APPROX_PRICES is NOT passed here. The
    // signed minimum is an on-chain commitment enforced on every fill until expiry, so it may rest
    // only on a live source; order ef85438b signed a floor off the stale table entry
    // APPROX_PRICES.CBETH = 3600 and became permanently unfillable (516 reverts). The parameters
    // were removed from DeriveSigningMinParams, so this is compiler-enforced. APPROX_PRICES stays
    // in use below for DISPLAY/dust-guard purposes, where a stale estimate is not fund-flow.
    let minAmountOut: string
    let maxSlippageBpsForConfig: number | undefined
    if (v3Enabled) {
      const derivation = deriveSigningMinAmountOut({
        amountIn: BigInt(amountIn),
        srcDecimals: tokenIn.decimals,
        dstDecimals: tokenOut.decimals,
        maxSlippageBps,
        chainlinkPriceIn, chainlinkPriceOut,
        defiLlamaPriceIn: llamaPriceIn, defiLlamaPriceOut: llamaPriceOut,
      })
      minAmountOut = derivation.minAmountOut.toString()
      maxSlippageBpsForConfig = maxSlippageBps
    } else {
      // minAmountOut = 1 wei for DCA — cannot be 0 (contract reverts with InvalidMinOutput).
      // Actual slippage protection is handled per-fill by the executor's swap route.
      minAmountOut = '1'
    }

    // DCA uses priceFeed = address(0) — the contract skips the Chainlink price check
    // entirely, executing on schedule at any price. This avoids MAX_STALENESS rejections
    // (contract has 300s staleness vs Chainlink's 3600s heartbeat).
    const priceFeed = '0x0000000000000000000000000000000000000000'

    const config: CreateOrderConfig = {
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      amountIn,
      minAmountOut,
      ...(maxSlippageBpsForConfig !== undefined ? { maxSlippageBps: maxSlippageBpsForConfig } : {}),
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
    // [FIX-DCA-NOFEED-CONSENT] Consent is per-creation — require it again for the NEXT order,
    // even against the same still-selected no-feed token.
    setNoFeedConsentGivenFor(null)
  }

  // [FIX-DCA-NOFEED-CONSENT] Gate BEFORE signing: a no-feed output token must show the consent
  // modal and get an explicit Accept before handleCreate ever runs. Feed-covered tokens skip this
  // entirely — byte-identical to the pre-existing submit path.
  async function handleCreateClick() {
    if (!canCreate) return
    if (noFeedOutput && !noFeedConsentGiven) {
      setShowNoFeedModal(true)
      return
    }
    await handleCreate()
  }

  function handleNoFeedAccept() {
    setShowNoFeedModal(false)
    setNoFeedConsentGivenFor(tokenOut?.address ?? null)
    void handleCreate()
  }

  function handleNoFeedReject() {
    setShowNoFeedModal(false)
    // Nothing signed, nothing submitted — the user is simply back on the panel.
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
            SAME hint copy the submit-time guard uses (useOrderEngine.ts, via formatMinBuyMessage —
            [fix/dca-min-buy-copy]). The hard block stays in createOrder — this is an inline
            advisory after a preset/manual fill lands under-floor. */}
        {minBuyMessage && (
          <p className="mt-1 text-[11px] text-amber-300">{minBuyMessage}</p>
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

      {/* [FEAT-DEPEG-GATE-ORDER-CREATION] cbETH depeg HARD block — mirrors SwapBox's copy so the same
          event reads identically wherever a user encounters it. No click-through: a 30-day autonomous
          DCA into a depegged asset is exactly the case this gate exists to stop. */}
      {depegHardBlocked && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="dca-depeg-block">
          <span className="font-semibold">&#9888; DCA blocked — {depegCheck.symbol} depeg.</span>{' '}
          {depegCheck.message}
          <span className="mt-1 block text-xs text-danger/80">
            The market price has diverged sharply from the protocol exchange rate — likely a depeg or oracle manipulation. This cannot be overridden. Try again once the prices reconverge.
          </span>
        </div>
      )}
      {/* [FEAT-DEPEG-GATE-ORDER-CREATION] The depeg check applies to this pair but could NOT be run —
          same posture and copy as SwapBox: blocks, but never claims a depeg when the truth is we
          could not check. Gated on a real amount so it never flashes on the default, inert form. */}
      {depegUnverified && tokenIn && tokenOut && Number(totalDisplay) > 0 && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="dca-depeg-unverified">
          <span className="font-semibold">&#9888; DCA paused — price not verified.</span>{' '}
          {depegCheck.message}
          <span className="mt-1 block text-xs text-danger/80">
            We could not get usable price-feed data to check this asset against its exchange rate, so we are not letting the order be created on a price we have not verified. This is not itself a depeg finding — we have not been able to make one either way. It clears once the feeds return good data.
          </span>
        </div>
      )}
      {/* [FEAT-DEPEG-GATE-ORDER-CREATION] Informed consent — 2–10% off the exchange rate. Mirrors
          SwapBox's checkbox exactly: the user must explicitly accept, and consent auto-revokes if
          the divergence worsens beyond accepted+tolerance. */}
      {depegConsentNeeded && (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="dca-depeg-consent">
          <span className="font-semibold">&#9888; Possible depeg:</span> {depegCheck.message}
          <label className="mt-2 flex min-h-[44px] items-center gap-2 text-xs text-warning/90 sm:min-h-0">
            <input
              type="checkbox"
              checked={depegAccepted}
              onChange={(e) => setAcceptedDepeg(e.target.checked ? depegCheck.divergence : null)}
              className="h-5 w-5 accent-warning"
            />
            I understand {depegCheck.symbol} may be depegged and want to proceed.
          </label>
        </div>
      )}

      {/* [FIX-DCA-PANEL-ORACLE-FAIL-CLOSED] The oracle block, surfaced with a reason that matches
          what actually happened. `oracle-integrity` is OUR side — a feed we could not read, or one
          whose identity/round did not verify — so the copy says exactly that and explicitly
          disclaims any finding about the token. It deliberately does NOT reuse the depeg banner's
          manipulation language: dressing our own feed outage or misconfiguration up as suspected
          manipulation would be a false accusation against the asset. `extreme-deviation` is the
          opposite case (a healthy feed the price has run away from) and gets its own copy. */}
      {oracleBlocked && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="dca-oracle-block">
          {oracleGate.reason === 'extreme-deviation' ? (
            <>
              <span className="font-semibold">&#9888; DCA blocked — price moved too far from the oracle.</span>{' '}
              {oracleGate.detail}
              <span className="mt-1 block text-xs text-danger/80">
                The quoted rate and the Chainlink reference price disagree by more than we allow. This is about the price, not about the feed — it clears when they reconverge.
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold">&#9888; DCA blocked — price could not be verified.</span>{' '}
              {oracleGate.detail}
              <span className="mt-1 block text-xs text-danger/80">
                This is a problem on our side with the Chainlink price feed for this pair — not a finding about {tokenOut?.symbol ?? 'this token'}, and not a sign the price moved. Every buy is signed against a minimum-output floor derived from that reference price, so we will not create an order on a price we could not verify. It clears once the feed returns good data.
              </span>
            </>
          )}
        </div>
      )}

      {/* [CHORE-DCA-CUSTOM-PERIODS] Custom toggle — switches buys + interval + expiry into
          custom-input mode together (they're coupled by the min-chunk/expiry guardrails).
          Preset behaviour (below, when off) is unchanged. */}
      <div className="mb-3 flex items-center justify-between">
        <label className="block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Number of Buys
        </label>
        <button
          type="button"
          onClick={() => { setCustomMode(!customMode); playClick() }}
          data-testid="dca-custom-toggle"
          className="min-h-[44px] text-[11px] font-medium text-cream-35 underline decoration-cream-15 underline-offset-2 hover:text-cream-50"
        >
          {customMode ? 'Use presets' : 'Custom'}
        </button>
      </div>

      {/* Number of parts */}
      <div className="mb-3">
        {customMode ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              inputMode="numeric"
              min={DCA_CUSTOM_BUYS_MIN}
              max={DCA_CUSTOM_BUYS_MAX}
              value={customBuysRaw}
              onChange={e => setCustomBuysRaw(Number(e.target.value))}
              onBlur={() => setCustomBuysRaw(clampCustomBuys(customBuysRaw))}
              data-testid="dca-custom-buys-input"
              className="w-24 rounded-lg border border-cream-08 bg-surface-primary px-3 py-2.5 text-sm text-cream outline-none focus:border-cream-35"
            />
            <span className="text-[12px] text-cream-35">buys ({DCA_CUSTOM_BUYS_MIN}–{DCA_CUSTOM_BUYS_MAX})</span>
          </div>
        ) : (
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
        )}
        {/* [CHORE-DCA-CUSTOM-PERIODS req.2 min-chunk] SC-02 dust guard — non-alarmist (amber)
            when auto-capped, red + submit-blocking when even 1 buy would be dust. */}
        {customMode && minChunkGuard.warning && (
          <p
            className={`mt-1 text-[11px] ${minChunkGuard.blocked ? 'text-red-400' : 'text-amber-300'}`}
            data-testid="dca-min-chunk-warning"
          >
            {minChunkGuard.warning}
          </p>
        )}
      </div>

      {/* Interval */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Interval
        </label>
        {customMode ? (
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="number"
              inputMode="numeric"
              min={DCA_CUSTOM_INTERVAL_NUMBER_MIN}
              max={DCA_CUSTOM_INTERVAL_NUMBER_MAX}
              value={customIntervalNumRaw}
              onChange={e => setCustomIntervalNumRaw(Number(e.target.value))}
              onBlur={() => setCustomIntervalNumRaw(clampCustomIntervalNumber(customIntervalNumRaw))}
              data-testid="dca-custom-interval-input"
              className="w-20 rounded-lg border border-cream-08 bg-surface-primary px-3 py-2.5 text-sm text-cream outline-none focus:border-cream-35"
            />
            {(['hours', 'days'] as const).map(u => (
              <button
                key={u}
                type="button"
                onClick={() => { setCustomIntervalUnit(u); playClick() }}
                data-testid={`dca-custom-interval-unit-${u}`}
                className={`inline-flex min-h-[44px] items-center justify-center rounded-lg border px-3 text-[12px] font-semibold transition-all ${
                  customIntervalUnit === u
                    ? 'border-cream-gold bg-cream-gold/10 text-cream'
                    : 'border-cream-08 text-cream-35 hover:border-cream-15 hover:text-cream-50'
                }`}
              >
                {u === 'hours' ? 'Hours' : 'Days'}
              </button>
            ))}
          </div>
        ) : (
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
        )}
      </div>

      {/* [CHORE-DCA-UX-POLISH] Order expiry — always visible (moved out of Advanced), alongside
          Number of Buys / Interval. State/values/behaviour unchanged for the preset path; only
          the render moved. [CHORE-DCA-CUSTOM-PERIODS] Custom mode auto-derives expiry instead of
          offering presets — see deriveCustomExpirySeconds. */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Order expiry
        </label>
        {customMode ? (
          <p className="text-[12px] text-cream-50" data-testid="dca-custom-expiry-auto">
            Auto: <span className="font-medium text-cream">{expiry.label}</span> ({parts} × {interval.label} + buffer)
          </p>
        ) : (
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
        )}
        {/* [chore/dca-resilience] Creation guard: interval × buys can't complete before this
            expiry → block submit (canCreate) and explain the fix. Also fires in Custom mode
            when interval*buys alone exceeds MAX_EXPIRY_DAYS (deriveCustomExpirySeconds caps
            the auto-derived expiry, so it lands below what the schedule needs). */}
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

          {/* [SPRINT-V3-P2 / ADR-013 §1] v3 max-slippage + derived floor — rendered ONLY once a
              real per-chain OrderExecutorV3 is configured (v3Enabled). Inert/hidden on every
              chain today; nothing here changes the v2 flow above. */}
          {v3Enabled && (
            <div className="rounded-xl border border-cream-08 bg-surface-primary p-3">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
                Max output slippage (per fill)
              </label>
              <div className="flex gap-2">
                {[100, 300, 500].map(bps => (
                  <button
                    key={bps}
                    onClick={() => setMaxSlippageBps(Math.min(bps, MAX_ORDER_SLIPPAGE_BPS))}
                    className={`inline-flex min-h-[44px] items-center justify-center rounded-lg border px-3 text-[12px] font-semibold transition-all ${
                      maxSlippageBps === bps
                        ? 'border-cream-gold bg-cream-gold/10 text-cream'
                        : 'border-cream-08 text-cream-35 hover:text-cream-50'
                    }`}
                  >
                    {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%
                  </button>
                ))}
              </div>
              {signingMin != null && tokenOut && (
                <p className="mt-2 text-[11px] text-cream-35">
                  Signed floor per order: ≥ {formatUnits(signingMin.minAmountOut, tokenOut.decimals)} {tokenOut.symbol}
                  {!signingMin.hasFeed && (
                    <span className="ml-1 text-amber-300">
                      (no price reference for this pair — fixed floor, not price-derived; it may
                      strand the order if price rises, or offer weak protection if it falls)
                    </span>
                  )}
                </p>
              )}
            </div>
          )}
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
          // [FIX-DCA-NOFEED-CONSENT] Routes through the consent gate first.
          onClick={async () => { playTouchMP3(); await handleCreateClick() }}
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

      {/* [FIX-DCA-NOFEED-CONSENT] Only ever shown for a no-feed OUTPUT token, before signing. */}
      <NoFeedConsentModal
        open={showNoFeedModal}
        tokenSymbol={tokenOut?.symbol || 'this token'}
        onAccept={handleNoFeedAccept}
        onReject={handleNoFeedReject}
      />
    </div>
  )
}
