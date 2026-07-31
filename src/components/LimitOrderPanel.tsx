'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import OrderReviewModal from './OrderReviewModal'
import OrderCancelReviewModal from './OrderCancelReviewModal'
import { fetchCurrentPrice } from '@/lib/limit-order-api'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import {
  OrderType,
  PriceCondition,
  EXPIRY_PRESETS,
  getDefaultRouter,
  getChainlinkFeeds,
  // [SPRINT-P1B / ADR-014 (a)] v3 pinned-route signing for Limit orders.
  getOrderExecutorV3,
  getCanonicalRouteRouter,
  buildCanonicalRoute,
  isLimitLive,
  DEFAULT_MAX_SLIPPAGE_BPS,
  checkMinOutEconomicFloor,
  pickCanonicalFeeTier,
} from '@/lib/order-engine'
import type { CreateOrderConfig, AutonomousOrder } from '@/lib/order-engine'
import { playClick, playTouchMP3, playSwapConfirmMP3, playCancelOrderMP3, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import { ETHERSCAN_TX, DEPEG_CONSENT_TOLERANCE } from '@/lib/constants'
import TokenSelector from './TokenSelector'
import BetaDisclaimer from './BetaDisclaimer'
// [FEAT-DEPEG-GATE-ORDER-CREATION] The same, twice-audited cbETH depeg circuit-breaker SwapBox
// uses — wired here so a Limit order cannot be created against a depegged/unverifiable pair with
// zero signal. Read-only reuse: neither the hook nor its thresholds are modified.
import { useDepegCheck } from '@/hooks/useDepegCheck'

// ── Stablecoin detection ─────────────────────────────────
const STABLECOIN_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'USDe', 'USDS', 'BOLD',
])
function isStablecoin(token: Token): boolean {
  return STABLECOIN_SYMBOLS.has(token.symbol)
}

// ── Map token to Chainlink feed ──────────────────────────
// Returns empty string if no feed found — callers must check before submitting.
function findPriceFeed(token: Token, chainId: number): string {
  const feeds = getChainlinkFeeds(chainId)
  const key = `${token.symbol}/USD`
  return feeds[key]?.address ?? ''
}

// Percentage preset buttons
const PRICE_PERCENT_PRESETS = [
  { label: '-10%', value: -10 },
  { label: '-5%', value: -5 },
  { label: '+5%', value: 5 },
  { label: '+10%', value: 10 },
]

// ══════════════════════════════════════════════════════════
//  MAIN PANEL
// ══════════════════════════════════════════════════════════
export default function LimitOrderPanel() {
  const [tab, setTab] = useState<'create' | 'orders'>('create')
  const { limitOrders, latestEvent, isSubmitting, createOrder, pendingOrder, confirmOrder, clearPendingOrder, cancelOrder, cancelAllOrders, removeOrder, pendingCancel, confirmCancel, clearPendingCancel } = useOrderEngine()
  const { address } = useAccount()
  const chainId = useChainId()

  const { toast } = useToast()

  // Browser push notifications (fires when tab is in background)
  useOrderNotifications(latestEvent)

  // Sound effects + toasts on events
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'order_created') {
      stopWaitingSound()
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'Limit order placed', description: 'Your order is live — it will execute automatically when your target price is reached.' })
    }
    if (latestEvent.type === 'order_filled') {
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'Limit order filled!', description: 'Your limit order has been executed.', txHash: latestEvent.txHash, duration: 10000 })
      if (address) {
        trackTrade({
          type: 'limit_fill',
          wallet: address,
          tokenIn: '', tokenInAddress: '',
          tokenOut: '', tokenOutAddress: '',
          amountIn: '0', amountOut: '0',
          volumeUsd: 0,
          source: 'teraswap_order_engine', txHash: latestEvent.txHash || '',
        })
      }
    }
    if (latestEvent.type === 'order_cancelled') {
      playCancelOrderMP3()
      toast({ type: 'success', title: 'Limit order cancelled', description: 'Your order has been cancelled on-chain.' })
    }
    if (latestEvent.type === 'order_error') {
      stopWaitingSound()
      playCancelOrderMP3()
      toast({ type: 'error', title: 'Limit order failed', description: latestEvent.error || 'Order could not be submitted.' })
    }
  }, [latestEvent, address])

  const activeLimit = limitOrders.filter(o =>
    o.status === 'active' || o.status === 'executing' || o.status === 'signing'
  )
  const historyLimit = limitOrders.filter(o =>
    o.status === 'filled' || o.status === 'expired' || o.status === 'cancelled' || o.status === 'error'
  )

  return (
    <div className="w-full max-w-[calc(100vw-2rem)] sm:max-w-[460px]">
      {/* [SPRINT-9U U2] EIP-712 review — no order is signed until the user confirms this frozen struct. */}
      {pendingOrder && <OrderReviewModal order={pendingOrder} onConfirm={confirmOrder} onCancel={clearPendingOrder} />}
      {/* [CANCEL-REVIEW] No cancel/invalidate executes until the user confirms this frozen plan. */}
      {pendingCancel && <OrderCancelReviewModal review={pendingCancel} onConfirm={confirmCancel} onCancel={clearPendingCancel} />}
      {/* Sub-tabs */}
      <div className="mb-3 flex gap-1 rounded-xl border border-cream-08 bg-surface-secondary/60 p-1">
        <button
          onClick={() => { setTab('create'); playClick() }}
          className={`flex-1 rounded-lg py-2 text-[13px] font-semibold transition-all ${
            tab === 'create'
              ? 'bg-cream-gold text-[#080B10]'
              : 'text-cream-50 hover:text-cream'
          }`}
        >
          New Limit Order
        </button>
        <button
          onClick={() => { setTab('orders'); playClick() }}
          className={`flex-1 rounded-lg py-2 text-[13px] font-semibold transition-all ${
            tab === 'orders'
              ? 'bg-cream-gold text-[#080B10]'
              : 'text-cream-50 hover:text-cream'
          }`}
        >
          Orders{activeLimit.length > 0 && ` (${activeLimit.length})`}
        </button>
      </div>

      {tab === 'create' ? (
        <CreateLimitForm onSubmit={createOrder} isSubmitting={isSubmitting} />
      ) : (
        <OrdersList
          active={activeLimit}
          history={historyLimit}
          onCancel={cancelOrder}
          onCancelAll={cancelAllOrders}
          onRemove={removeOrder}
        />
      )}

      {/* Beta disclaimer */}
      <BetaDisclaimer />
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  CREATE LIMIT ORDER FORM
// ══════════════════════════════════════════════════════════
function CreateLimitForm({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (config: CreateOrderConfig) => Promise<void>
  isSubmitting: boolean
}) {
  const { isConnected } = useAccount()
  const chainId = useChainId()

  const [tokenIn, setTokenIn] = useState<Token>(DEFAULT_TOKENS[0])   // ETH
  const [tokenOut, setTokenOut] = useState<Token>(DEFAULT_TOKENS[2])  // USDC
  const [amount, setAmount] = useState('')
  const [expiryIdx, setExpiryIdx] = useState(2) // 7 days default
  // [SPRINT-P1B] Blocking reason surfaced before approve/sign (dust floor, route build, no feed).
  const [submitError, setSubmitError] = useState<string | null>(null)
  // [SPRINT-P1B / ADR-014 (a)] v3 pinned-route signing behind the full launch gate; fail-closed.
  const v3Live = isLimitLive(chainId)
  const [maxSlippageBps] = useState(DEFAULT_MAX_SLIPPAGE_BPS)

  // [FEAT-DEPEG-GATE-ORDER-CREATION] Same hook, same semantics as SwapBox — see DCAPanel.tsx for
  // the full mode-by-mode rationale. Consent resets on a chain switch (a new chain is a new trade).
  const depegCheck = useDepegCheck(tokenIn?.address, tokenOut?.address)
  const [acceptedDepeg, setAcceptedDepeg] = useState<number | null>(null)
  useEffect(() => { setAcceptedDepeg(null) }, [chainId])
  const depegConsentNeeded = depegCheck.mode === 'consent'
  const depegAccepted = acceptedDepeg != null && depegCheck.divergence <= acceptedDepeg + DEPEG_CONSENT_TOLERANCE
  const depegConsentBlocking = depegConsentNeeded && !depegAccepted
  const depegHardBlocked = depegCheck.mode === 'block'
  const depegUnverified = depegCheck.mode === 'unverified'
  const depegBlocking = depegHardBlocked || depegConsentBlocking || depegUnverified

  // ── Price state ──────────────────────────────────────────
  const [targetPrice, setTargetPrice] = useState('')
  const [displayPriceInput, setDisplayPriceInput] = useState('')
  const [marketPrice, setMarketPrice] = useState<number>(0)
  const [loadingPrice, setLoadingPrice] = useState(false)

  const [priceInverted, setPriceInverted] = useState(false)

  // Auto-detect: if selling stablecoin for crypto, invert
  useEffect(() => {
    const sellIsStable = isStablecoin(tokenIn)
    const buyIsStable = isStablecoin(tokenOut)
    setPriceInverted(sellIsStable && !buyIsStable)
  }, [tokenIn?.address, tokenOut?.address])

  const baseToken = priceInverted ? tokenOut : tokenIn
  const quoteToken = priceInverted ? tokenIn : tokenOut

  const internalToDisplay = useCallback((internal: number): number => {
    if (!priceInverted || internal <= 0) return internal
    return 1 / internal
  }, [priceInverted])

  const displayToInternal = useCallback((display: number): number => {
    if (!priceInverted || display <= 0) return display
    return 1 / display
  }, [priceInverted])

  const displayMarketPrice = useMemo(() => {
    return internalToDisplay(marketPrice)
  }, [marketPrice, internalToDisplay])

  // Fetch market price when tokens change
  useEffect(() => {
    if (!tokenIn || !tokenOut) return
    const fetchPrice = async () => {
      setLoadingPrice(true)
      try {
        const oneUnit = parseUnits('1', tokenIn.decimals).toString()
        const price = await fetchCurrentPrice(
          tokenIn.address,
          tokenOut.address,
          oneUnit,
          tokenIn.decimals,
          tokenOut.decimals,
          chainId,
        )
        setMarketPrice(price)
        if (!targetPrice && price > 0) {
          setTargetPrice(formatPrice(price, tokenOut))
          setDisplayPriceInput(formatPrice(internalToDisplay(price), priceInverted ? tokenIn : tokenOut))
        }
      } catch { /* silent */ }
      setLoadingPrice(false)
    }
    fetchPrice()
  }, [tokenIn?.address, tokenOut?.address, chainId])

  useEffect(() => {
    const internal = parseFloat(targetPrice)
    if (!isNaN(internal) && internal > 0) {
      const dp = internalToDisplay(internal)
      setDisplayPriceInput(formatPrice(dp, quoteToken))
    }
  }, [priceInverted])

  const handleDisplayPriceChange = (rawInput: string) => {
    setDisplayPriceInput(rawInput)
    if (!rawInput) { setTargetPrice(''); return }
    const dp = parseFloat(rawInput)
    if (isNaN(dp) || dp <= 0) return
    const internal = displayToInternal(dp)
    setTargetPrice(internal.toString())
  }

  const setInternalPrice = useCallback((internal: number) => {
    setTargetPrice(formatPrice(internal, tokenOut))
    const dp = internalToDisplay(internal)
    setDisplayPriceInput(formatPrice(dp, quoteToken))
  }, [tokenOut, quoteToken, internalToDisplay])

  const applyPercentAdjust = (percent: number) => {
    if (marketPrice <= 0) return
    playClick()
    const adjusted = marketPrice * (1 + percent / 100)
    setInternalPrice(adjusted)
  }

  const togglePriceDirection = () => {
    setPriceInverted(prev => !prev)
    playClick()
  }

  const buyPreview = useMemo(() => {
    if (!amount || !targetPrice) return ''
    try {
      const sellRaw = parseUnits(amount, tokenIn.decimals)
      const price = parseFloat(targetPrice)
      if (price <= 0) return ''
      // [BUGFIX] Use BigInt arithmetic to avoid precision loss for large amounts
      // (Number(sellRaw) overflows past 2^53)
      const priceBn = BigInt(Math.round(price * 1e18))
      const expectedRaw = sellRaw * priceBn / BigInt(1e18)
      const decDiff = tokenOut.decimals - tokenIn.decimals
      const adjusted = decDiff > 0
        ? expectedRaw * BigInt(10 ** decDiff)
        : decDiff < 0
          ? expectedRaw / BigInt(10 ** Math.abs(decDiff))
          : expectedRaw
      return Number(formatUnits(adjusted, tokenOut.decimals)).toFixed(tokenOut.decimals <= 6 ? 2 : 6)
    } catch { return '' }
  }, [amount, targetPrice, tokenIn, tokenOut])

  const priceDiffPercent = useMemo(() => {
    if (!targetPrice || !marketPrice) return null
    const target = parseFloat(targetPrice)
    if (target <= 0 || marketPrice <= 0) return null
    return ((target - marketPrice) / marketPrice) * 100
  }, [targetPrice, marketPrice])

  const orderIntent = useMemo(() => {
    const sellIsStable = isStablecoin(tokenIn)
    const buyIsStable = isStablecoin(tokenOut)
    if (sellIsStable && !buyIsStable) {
      return { label: 'Buy below', hint: `Buy ${tokenOut.symbol} when price drops` }
    }
    if (!sellIsStable && buyIsStable) {
      return { label: 'Take profit', hint: `Sell ${tokenIn.symbol} when price rises` }
    }
    return null
  }, [tokenIn, tokenOut])

  const handleSubmit = async () => {
    if (!amount || !targetPrice || !isConnected) return

    // [FEAT-DEPEG-GATE-ORDER-CREATION] Hard guard (defense-in-depth): never sign a Limit order
    // against a depegged or unverifiable pair. The submit button is already disabled on this same
    // condition; this also blocks any programmatic call. Message is sourced straight from the
    // depeg gate, so the reason a user sees on submit matches the live banner above verbatim.
    if (depegBlocking) {
      setSubmitError(depegCheck.message ?? 'This pair could not be verified against its exchange rate.')
      return
    }

    startWaitingSound()

    let amountIn: string
    try {
      amountIn = parseUnits(amount, tokenIn.decimals).toString()
    } catch {
      return // Invalid input (e.g. too many decimals)
    }
    // Convert target price to Chainlink 8-decimal format
    const targetPriceFloat = parseFloat(targetPrice)
    // For limit: if selling stablecoin to buy crypto → condition BELOW (buy when price drops)
    // If selling crypto for stablecoin → condition ABOVE (sell when price rises)
    const sellIsStable = isStablecoin(tokenIn)
    const condition = sellIsStable ? PriceCondition.BELOW : PriceCondition.ABOVE

    // Target price in Chainlink 8-decimal format (USD price)
    // We use the display price (USD) for the Chainlink feed
    const usdPrice = displayMarketPrice > 0
      ? (targetPriceFloat / marketPrice) * displayMarketPrice
      : targetPriceFloat
    const targetPrice8dec = Math.round(usdPrice * 1e8).toString()

    // Min amount out (with 2% slippage from expected)
    // [BUGFIX] Use BigInt arithmetic to avoid precision loss beyond 2^53
    const amountInBn = BigInt(amountIn)
    const priceBn = BigInt(Math.round(targetPriceFloat * 1e18))
    const expectedOutRaw = amountInBn * priceBn / BigInt(1e18)
    // Adjust for decimal difference between tokenIn and tokenOut
    const decDiff = tokenOut.decimals - tokenIn.decimals
    const expectedOutAdjusted = decDiff > 0
      ? expectedOutRaw * BigInt(10 ** decDiff)
      : decDiff < 0
        ? expectedOutRaw / BigInt(10 ** Math.abs(decDiff))
        : expectedOutRaw
    // [SPRINT-P1B / ADR-013 §1] On v3 the signed floor comes from the user's target price and the
    // signed slippage bound; the BINDING on-chain floor stays max(oracleFloor, minAmountOut)
    // (TeraSwapOrderExecutorV3.sol:532-554). v2 keeps the legacy flat 2%.
    const minAmountOutBn = v3Live
      ? (expectedOutAdjusted * BigInt(10_000 - maxSlippageBps)) / 10_000n
      : (expectedOutAdjusted * 98n) / 100n
    const minAmountOut = minAmountOutBn.toString()

    const feedToken = sellIsStable ? tokenOut : tokenIn
    const priceFeed = findPriceFeed(feedToken, chainId)
    if (!priceFeed) {
      stopWaitingSound()
      setSubmitError(`No Chainlink price feed available for ${feedToken.symbol}. Select a supported token.`)
      return
    }

    // ── [SPRINT-P1B] $1 economic-floor pre-flight, BEFORE approve ──
    // Must run before onSubmit: the approve button only exists inside the review modal that
    // createOrder mounts, so failing later would cost the user an approve tx + a signature.
    const floorCheck = checkMinOutEconomicFloor({
      minAmountOut: minAmountOutBn,
      tokenOutDecimals: tokenOut.decimals,
      tokenOutUsdPrice: isStablecoin(tokenOut) ? 1 : null,
    })
    if (floorCheck.blocked) {
      stopWaitingSound()
      setSubmitError(floorCheck.reason)
      return
    }

    let config: CreateOrderConfig = {
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      amountIn,
      minAmountOut,
      orderType: OrderType.LIMIT,
      condition,
      targetPrice: targetPrice8dec,
      priceFeed,
      expirySeconds: EXPIRY_PRESETS[expiryIdx].seconds,
      router: getDefaultRouter(chainId).address,
    }

    // ── [SPRINT-P1B / ADR-014 (a)] v3 pinned canonical route ──
    // Non-DCA on v3 REQUIRES a real routerDataHash (V3:463-465). The route is pinned here at
    // signing (quote-free, so it stays valid until expiry) and replayed verbatim by the keeper.
    if (v3Live) {
      const canonicalRouter = getCanonicalRouteRouter(chainId)
      const executorV3 = getOrderExecutorV3(chainId)
      if (!canonicalRouter || !executorV3) {
        stopWaitingSound()
        setSubmitError('Limit orders are unavailable on this network right now.')
        return
      }
      try {
        const route = buildCanonicalRoute({
          tokenIn: tokenIn.address as `0x${string}`,
          tokenOut: tokenOut.address as `0x${string}`,
          amountIn: amountInBn,
          minAmountOut: minAmountOutBn,
          feeTier: pickCanonicalFeeTier({
            tokenInIsStable: isStablecoin(tokenIn),
            tokenOutIsStable: isStablecoin(tokenOut),
          }),
          router: canonicalRouter.address,
          recipient: executorV3,
        })
        config = {
          ...config,
          router: route.router,
          routerDataHash: route.routerDataHash,
          routerData: route.routerData,
          maxSlippageBps,
        }
      } catch (err) {
        stopWaitingSound()
        setSubmitError(err instanceof Error ? err.message : 'Could not build the swap route for this pair.')
        return
      }
    }

    setSubmitError(null)
    await onSubmit(config)
    setAmount('')
  }

  const clearPrice = () => {
    setTargetPrice('')
    setDisplayPriceInput('')
    setMarketPrice(0)
  }

  const handleTokenInSelect = (token: Token) => {
    if (token.address === tokenOut.address) setTokenOut(tokenIn)
    setTokenIn(token)
    clearPrice()
  }

  const handleTokenOutSelect = (token: Token) => {
    if (token.address === tokenIn.address) setTokenIn(tokenOut)
    setTokenOut(token)
    clearPrice()
  }

  const handleSwapTokens = () => {
    playClick()
    const prevIn = tokenIn
    const prevOut = tokenOut
    setTokenIn(prevOut)
    setTokenOut(prevIn)
    clearPrice()
  }

  const setMarketAsTarget = () => {
    if (marketPrice > 0) { setInternalPrice(marketPrice); playClick() }
  }

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      {/* Order intent badge */}
      {orderIntent && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2">
          <span className="text-[11px] font-semibold text-cream-gold">{orderIntent.label}</span>
          <span className="text-[10px] text-cream-50">{orderIntent.hint}</span>
        </div>
      )}

      {/* Sell token */}
      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">Sell</label>
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-primary px-3 py-2.5">
          <TokenSelector selected={tokenIn} onSelect={handleTokenInSelect} disabledAddress={tokenOut?.address} />
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            // [BUGFIX] Prevent multiple decimal points (old regex /[^0-9.]/g allowed "1.2.3")
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              // Only allow one decimal point
              const parts = v.split('.')
              setAmount(parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : v)
            }}
            className="flex-1 bg-transparent text-right text-lg font-semibold text-cream outline-none placeholder:text-cream-20"
          />
        </div>
      </div>

      {/* Swap direction button */}
      <div className="my-2 flex justify-center">
        <button
          onClick={handleSwapTokens}
          className="rounded-full border border-cream-08 bg-surface-primary p-1.5 text-cream-50 transition-all hover:border-cream-35 hover:text-cream active:scale-90"
          title="Swap sell ↔ buy"
        >
          ⇅
        </button>
      </div>

      {/* Buy token */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">Receive</label>
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-primary px-3 py-2.5">
          <TokenSelector selected={tokenOut} onSelect={handleTokenOutSelect} disabledAddress={tokenIn?.address} />
          <span className="flex-1 text-right text-sm text-cream-35">
            {buyPreview ? `≈ ${buyPreview}` : 'Set limit price below'}
          </span>
        </div>
      </div>

      {/* [FEAT-DEPEG-GATE-ORDER-CREATION] cbETH depeg HARD block — mirrors SwapBox's copy so the
          same event reads identically wherever a user encounters it. No click-through. */}
      {depegHardBlocked && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="limit-depeg-block">
          <span className="font-semibold">&#9888; Order blocked — {depegCheck.symbol} depeg.</span>{' '}
          {depegCheck.message}
          <span className="mt-1 block text-xs text-danger/80">
            The market price has diverged sharply from the protocol exchange rate — likely a depeg or oracle manipulation. This cannot be overridden. Try again once the prices reconverge.
          </span>
        </div>
      )}
      {/* [FEAT-DEPEG-GATE-ORDER-CREATION] The depeg check applies but could NOT be run — same
          posture and copy as SwapBox: blocks, but never claims a depeg when the truth is we could
          not check. */}
      {depegUnverified && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="limit-depeg-unverified">
          <span className="font-semibold">&#9888; Order paused — price not verified.</span>{' '}
          {depegCheck.message}
          <span className="mt-1 block text-xs text-danger/80">
            We could not get usable price-feed data to check this asset against its exchange rate, so we are not letting the order be created on a price we have not verified. This is not itself a depeg finding — we have not been able to make one either way. It clears once the feeds return good data.
          </span>
        </div>
      )}
      {/* [FEAT-DEPEG-GATE-ORDER-CREATION] Informed consent — 2–10% off the exchange rate, same
          checkbox shape as SwapBox. */}
      {depegConsentNeeded && (
        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning" data-testid="limit-depeg-consent">
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

      {/* Target price */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <button
            onClick={togglePriceDirection}
            className="flex items-center gap-1.5 text-xs text-cream-50 transition hover:text-cream"
            title="Flip price direction"
          >
            <span className="text-cream-gold">⇄</span>
            1 {baseToken.symbol} = ? {quoteToken.symbol}
          </button>
          {displayMarketPrice > 0 && (
            <button onClick={setMarketAsTarget} className="text-[10px] text-cream-gold hover:underline">
              Market: {formatPrice(displayMarketPrice, quoteToken)}
            </button>
          )}
        </div>
        <input
          type="number"
          step="any"
          placeholder={loadingPrice ? 'Loading...' : '0.0'}
          value={displayPriceInput}
          onChange={(e) => handleDisplayPriceChange(e.target.value)}
          className="w-full rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2.5 text-sm text-cream outline-none focus:border-cream-35"
        />

        {/* Percentage adjustment buttons */}
        {marketPrice > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PRICE_PERCENT_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => applyPercentAdjust(p.value)}
                className={`flex-1 rounded-md border py-1 text-[10px] font-medium transition ${
                  p.value < 0
                    ? 'border-cream-08 bg-surface-tertiary text-red-400 hover:border-red-400/30'
                    : 'border-cream-08 bg-surface-tertiary text-green-400 hover:border-green-400/30'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {priceDiffPercent !== null && (
          <p className={`mt-1 text-[11px] ${
            priceDiffPercent > 0
              ? 'text-green-400'
              : priceDiffPercent < -5
                ? 'text-warning'
                : 'text-cream-50'
          }`}>
            {priceDiffPercent > 0 ? '+' : ''}{priceDiffPercent.toFixed(2)}% vs market
          </p>
        )}
      </div>

      {/* Expiry presets */}
      <div className="mb-3">
        <label className="mb-1 block text-xs text-cream-50">Expires in</label>
        <div className="flex gap-1.5">
          {EXPIRY_PRESETS.slice(0, 4).map((preset, i) => (
            <button
              key={preset.seconds}
              onClick={() => { setExpiryIdx(i); playClick() }}
              className={`flex-1 rounded-lg py-2 text-[11px] font-medium transition ${
                expiryIdx === i
                  ? 'border border-cream bg-cream text-black'
                  : 'border border-cream-08 bg-surface-tertiary text-cream-65 hover:border-cream-35'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Submit */}
      {!isConnected ? (
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      ) : (
        <button
          // [BUGFIX] await async handleSubmit to catch errors properly
          onClick={async () => { playTouchMP3(); await handleSubmit() }}
          disabled={isSubmitting || !amount || !targetPrice || depegBlocking}
          className={`w-full rounded-xl py-3 text-sm font-bold transition-all ${
            isSubmitting || !amount || !targetPrice || depegBlocking
              ? 'cursor-not-allowed bg-cream-08 text-cream-35'
              : 'bg-cream-gold text-[#080B10] hover:brightness-110 active:scale-[0.98]'
          }`}
        >
          {isSubmitting ? 'Signing order...' : 'Place Limit Order'}
        </button>
      )}

      {/* [SPRINT-P1B] Pre-approve blocking reason (dust floor / route build / missing feed). */}
      {submitError && (
        <div
          data-testid="limit-submit-error"
          className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300"
        >
          {submitError}
        </div>
      )}

      {/* [SPRINT-P1B / ADR-014 (a)] Honest liveness copy — a pinned route is not a fill guarantee. */}
      {v3Live && (
        <div
          data-testid="pinned-route-liveness-note"
          className="mt-2 rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2 text-[10px] text-cream-50"
        >
          This order executes when your price is met <strong className="text-cream-65">if the pinned
          route is viable</strong> at that moment; otherwise it stays open until it expires. The
          route is fixed when you sign, so a changed quote cannot alter it — but it also cannot
          re-route around a pool that has dried up.
        </div>
      )}

      {/* Info badge */}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2">
        <span className="text-[10px] text-cream-50">
          <span className="font-semibold text-cream-gold">Autonomous execution</span> — Chainlink oracles monitor price. Your order executes via 1inch when target is hit. Approve once, then sign — no infinite approvals, no browser needed.
        </span>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  ORDERS LIST
// ══════════════════════════════════════════════════════════
function OrdersList({
  active,
  history,
  onCancel,
  onCancelAll,
  onRemove,
}: {
  active: AutonomousOrder[]
  history: AutonomousOrder[]
  onCancel: (id: string) => void
  onCancelAll: () => Promise<void>
  onRemove: (id: string) => void
}) {
  if (active.length === 0 && history.length === 0) {
    return (
      <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-6 text-center text-sm text-cream-50">
        No limit orders yet. Create one to get started.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {active.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-cream-50">Active Orders</h4>
            {active.length > 1 && (
              <button
                onClick={() => { onCancelAll(); playClick() }}
                className="rounded-lg border border-danger/30 px-2.5 py-1 text-[10px] text-danger/70 hover:text-danger transition-colors"
              >
                Cancel All
              </button>
            )}
          </div>
          {active.map(order => (
            <OrderCard key={order.id} order={order} onCancel={onCancel} />
          ))}
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="flex items-center justify-between mt-3">
            <h4 className="text-xs font-semibold text-cream-50">History</h4>
            {history.length > 1 && (
              <button
                onClick={() => { history.forEach(o => onRemove(o.id)); playClick() }}
                className="rounded-lg border border-cream-08 px-2.5 py-1 text-[10px] text-cream-35 hover:text-cream-50 transition-colors"
              >
                Remove All
              </button>
            )}
          </div>
          {history.map(order => (
            <OrderCard key={order.id} order={order} onRemove={onRemove} />
          ))}
        </>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  ORDER CARD
// ══════════════════════════════════════════════════════════
function OrderCard({
  order,
  onCancel,
  onRemove,
}: {
  order: AutonomousOrder
  onCancel?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  const [currentPrice, setCurrentPrice] = useState<number | null>(null)
  const chainId = useChainId()

  const statusColors: Record<string, string> = {
    signing: 'text-yellow-400',
    active: 'text-blue-400',
    executing: 'text-cyan-400',
    filled: 'text-green-400',
    expired: 'text-cream-35',
    cancelled: 'text-cream-35',
    error: 'text-red-400',
  }

  const statusLabels: Record<string, string> = {
    signing: 'Signing...',
    active: 'Watching...',
    executing: 'Executing...',
    filled: 'Filled',
    expired: 'Expired',
    cancelled: 'Cancelled',
    error: 'Failed',
  }

  const amountIn = order.order?.amountIn
    ? formatUnits(BigInt(order.order.amountIn.toString()), order.tokenInDecimals)
    : '—'

  // Target price from Chainlink 8-decimal format
  const targetPriceUsd = useMemo(() => {
    if (!order.order?.targetPrice) return null
    return Number(BigInt(order.order.targetPrice.toString())) / 1e8
  }, [order.order?.targetPrice])

  // Condition label (buy when price ≥ or ≤ target)
  const conditionLabel = order.order?.condition === PriceCondition.ABOVE ? '≥' : '≤'

  const timeLeft = order.expiresAt - Date.now()
  const hoursLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60)))
  const daysLeft = Math.floor(hoursLeft / 24)

  const isActive = order.status === 'active' || order.status === 'executing' || order.status === 'signing'

  // Fetch current price every 30s for active orders
  useEffect(() => {
    if (!isActive || !order.order?.amountIn) return

    let cancelled = false
    const fetchPrice = async () => {
      try {
        const tokenIn = order.order.tokenIn
        const tokenOut = order.order.tokenOut
        const sellAmount = order.order.amountIn.toString()
        const price = await fetchCurrentPrice(
          tokenIn, tokenOut, sellAmount,
          order.tokenInDecimals, order.tokenOutDecimals,
          chainId,
        )
        if (!cancelled && price > 0) setCurrentPrice(price)
      } catch { /* silently ignore */ }
    }

    fetchPrice()
    const interval = setInterval(fetchPrice, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [isActive, order.order?.tokenIn, order.order?.tokenOut, order.order?.amountIn, order.tokenInDecimals, order.tokenOutDecimals, chainId])

  // Price distance percentage
  const priceInfo = useMemo(() => {
    if (!targetPriceUsd || !currentPrice || currentPrice === 0) return null
    const diff = ((currentPrice - targetPriceUsd) / targetPriceUsd) * 100
    const absDiff = Math.abs(diff)
    // Progress: 100% = at target, 0% = far from target
    const progress = Math.max(0, Math.min(100, 100 - absDiff))
    return { diff, absDiff, progress }
  }, [targetPriceUsd, currentPrice])

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-secondary p-3">
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cream">
            {Number(amountIn).toFixed(4)} {order.tokenInSymbol}
          </span>
          <span className="text-cream-35">→</span>
          <span className="text-sm font-medium text-cream">
            {order.tokenOutSymbol}
          </span>
        </div>
        <span className={`text-[11px] font-semibold ${statusColors[order.status] || 'text-cream-50'}`}>
          {statusLabels[order.status] || order.status}
        </span>
      </div>

      {/* Price info */}
      {targetPriceUsd !== null && targetPriceUsd > 0 && (
        <div className="mb-2 rounded-lg bg-cream-04 px-2.5 py-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-cream-50">Target ({conditionLabel})</span>
            <span className="font-medium text-cream-gold">${targetPriceUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
          {currentPrice !== null && currentPrice > 0 && (
            <>
              <div className="mt-1 flex items-center justify-between text-[11px]">
                <span className="text-cream-50">Current</span>
                <span className="font-medium text-cream">${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              {priceInfo && (
                <div className="mt-1.5">
                  <div className="mb-0.5 flex items-center justify-between text-[10px]">
                    <span className="text-cream-35">
                      {priceInfo.absDiff < 0.5 ? '🟢 Almost there!' : `${priceInfo.absDiff.toFixed(1)}% away`}
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-cream-08">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${priceInfo.progress}%`,
                        backgroundColor: priceInfo.progress > 90 ? '#22c55e' : priceInfo.progress > 50 ? '#eab308' : '#64748b',
                      }}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Expiry */}
      <div className="mb-2 flex items-center justify-between text-[11px] text-cream-50">
        <span>Limit order</span>
        {isActive && timeLeft > 0 && (
          <span>{daysLeft > 0 ? `${daysLeft}d ${hoursLeft % 24}h` : `${hoursLeft}h`} left</span>
        )}
      </div>

      {/* Error */}
      {order.error && (
        <p className="mb-2 text-[11px] text-red-400">{order.error}</p>
      )}

      {/* Tx hash */}
      {order.txHash && (
        <a
          href={`${ETHERSCAN_TX}${order.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-2 block text-[11px] text-cream-gold hover:underline"
        >
          View on Etherscan ↗
        </a>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {onCancel && isActive && (
          <button
            onClick={() => { onCancel(order.id); playClick() }}
            className="rounded-lg border border-danger/30 px-3 py-1.5 text-[11px] text-danger/70 hover:text-danger transition-colors"
          >
            Cancel
          </button>
        )}
        {onRemove && !isActive && (
          <button
            onClick={() => { onRemove(order.id); playClick() }}
            className="rounded-lg border border-cream-08 px-3 py-1.5 text-[11px] text-cream-50 transition hover:border-cream-35 hover:text-cream"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  )
}

// ── Helper: format price with smart decimals ────────────────
function formatPrice(value: number, quoteToken: Token): string {
  if (value === 0) return '0'
  if (isStablecoin(quoteToken)) return value.toFixed(2)
  if (value < 0.001) return value.toFixed(8)
  if (value < 1) return value.toFixed(6)
  return value.toFixed(quoteToken.decimals <= 6 ? 2 : 6)
}
