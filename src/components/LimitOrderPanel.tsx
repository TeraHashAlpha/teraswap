'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import { fetchCurrentPrice } from '@/lib/limit-order-api'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import {
  OrderType,
  PriceCondition,
  EXPIRY_PRESETS,
  getDefaultRouter,
  getChainlinkFeeds,
} from '@/lib/order-engine'
import type { CreateOrderConfig, AutonomousOrder } from '@/lib/order-engine'
import { playClick, playTouchMP3, playSwapConfirmMP3, playCancelOrderMP3, playError, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import { ETHERSCAN_TX } from '@/lib/constants'
import TokenSelector from './TokenSelector'
import BetaDisclaimer from './BetaDisclaimer'

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
  const { limitOrders, latestEvent, isSubmitting, createOrder, cancelOrder, cancelAllOrders, removeOrder } = useOrderEngine()
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
  const [showAdvanced, setShowAdvanced] = useState(false)

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
  }, [tokenIn?.address, tokenOut?.address])

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
    // Apply 2% slippage: multiply by 98, divide by 100
    const minAmountOut = (expectedOutAdjusted * 98n / 100n).toString()

    const feedToken = sellIsStable ? tokenOut : tokenIn
    const priceFeed = findPriceFeed(feedToken, chainId)
    if (!priceFeed) {
      throw new Error(`No Chainlink price feed available for ${feedToken.symbol}. Select a supported token.`)
    }

    const config: CreateOrderConfig = {
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
          disabled={isSubmitting || !amount || !targetPrice}
          className={`w-full rounded-xl py-3 text-sm font-bold transition-all ${
            isSubmitting || !amount || !targetPrice
              ? 'cursor-not-allowed bg-cream-08 text-cream-35'
              : 'bg-cream-gold text-[#080B10] hover:brightness-110 active:scale-[0.98]'
          }`}
        >
          {isSubmitting ? 'Signing order...' : 'Place Limit Order'}
        </button>
      )}

      {/* Info badge */}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2">
        <span className="text-[10px] text-cream-50">
          <span className="font-semibold text-cream-gold">Autonomous execution</span> — Chainlink oracles monitor price. Your order executes via 1inch when target is hit. Sign once, no browser needed.
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
        )
        if (!cancelled && price > 0) setCurrentPrice(price)
      } catch { /* silently ignore */ }
    }

    fetchPrice()
    const interval = setInterval(fetchPrice, 30_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [isActive, order.order?.tokenIn, order.order?.tokenOut, order.order?.amountIn, order.tokenInDecimals, order.tokenOutDecimals])

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
