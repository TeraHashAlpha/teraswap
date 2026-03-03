'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useLimitOrder } from '@/hooks/useLimitOrder'
import { fetchCurrentPrice } from '@/lib/limit-order-api'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import { LIMIT_EXPIRY_PRESETS, type LimitOrderConfig } from '@/lib/limit-order-types'
import { playClick, playLimitPlaced, playApproval, playError } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import TokenSelector from './TokenSelector'

// ── Stablecoin detection ─────────────────────────────────
const STABLECOIN_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'USDe', 'USDS',
])
function isStablecoin(token: Token): boolean {
  return STABLECOIN_SYMBOLS.has(token.symbol)
}

// Percentage preset buttons for quick price adjustment
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
  const { activeOrders, historyOrders, latestEvent, isSubmitting, createOrder, cancelOrder, removeOrder } = useLimitOrder()
  const { address } = useAccount()

  const { toast } = useToast()

  // Sound effects + toasts on events
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'order_signed') {
      playLimitPlaced()
      toast({ type: 'success', title: 'Limit order placed', description: 'Your order is live — CoW solvers will compete to fill it.' })
    }
    if (latestEvent.type === 'order_filled') {
      playApproval()
      toast({ type: 'success', title: 'Limit order filled!', description: 'Your limit order has been executed.', txHash: latestEvent.txHash, duration: 10000 })
      if (address) {
        trackTrade({
          type: 'limit_fill',
          wallet: address,
          tokenIn: '', tokenInAddress: '',
          tokenOut: '', tokenOutAddress: '',
          amountIn: '0', amountOut: '0',
          volumeUsd: 0,
          source: 'cowswap', txHash: latestEvent.txHash || '',
        })
      }
    }
    if (latestEvent.type === 'order_error') {
      playError()
      toast({ type: 'error', title: 'Limit order failed', description: latestEvent.error || 'Order could not be submitted.' })
    }
  }, [latestEvent, address])

  const orderCount = activeOrders.length

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
          Orders{orderCount > 0 && ` (${orderCount})`}
        </button>
      </div>

      {tab === 'create' ? (
        <CreateLimitForm onSubmit={createOrder} isSubmitting={isSubmitting} />
      ) : (
        <OrdersList
          active={activeOrders}
          history={historyOrders}
          onCancel={cancelOrder}
          onRemove={removeOrder}
        />
      )}
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
  onSubmit: (config: LimitOrderConfig) => Promise<void>
  isSubmitting: boolean
}) {
  const { address, isConnected } = useAccount()

  const [tokenIn, setTokenIn] = useState<Token>(DEFAULT_TOKENS[0])   // ETH
  const [tokenOut, setTokenOut] = useState<Token>(DEFAULT_TOKENS[2])  // USDC
  const [amount, setAmount] = useState('')
  const [expiryIdx, setExpiryIdx] = useState(2) // 7 days default
  const [partialFill, setPartialFill] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // ── Price state ──────────────────────────────────────────
  // Internal targetPrice is ALWAYS in "tokenOut per tokenIn" (what CoW needs)
  const [targetPrice, setTargetPrice] = useState('')
  // Display price input is what the user sees/types (may be inverted)
  const [displayPriceInput, setDisplayPriceInput] = useState('')
  const [marketPrice, setMarketPrice] = useState<number>(0)
  const [loadingPrice, setLoadingPrice] = useState(false)

  // Display price can be inverted for readability
  // "inverted" means we show "1 tokenOut = ? tokenIn" instead of "1 tokenIn = ? tokenOut"
  const [priceInverted, setPriceInverted] = useState(false)

  // Auto-detect: if selling a stablecoin to buy a non-stablecoin, invert by default
  // so user sees "1 ETH = X USDC" instead of "1 USDC = 0.000X ETH"
  useEffect(() => {
    const sellIsStable = isStablecoin(tokenIn)
    const buyIsStable = isStablecoin(tokenOut)
    setPriceInverted(sellIsStable && !buyIsStable)
  }, [tokenIn?.address, tokenOut?.address])

  // ── Display price helpers ─────────────────────────────────
  const baseToken = priceInverted ? tokenOut : tokenIn
  const quoteToken = priceInverted ? tokenIn : tokenOut

  // Convert between internal (tokenOut/tokenIn) and display price
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
        // Pre-fill target price if empty
        if (!targetPrice && price > 0) {
          setTargetPrice(formatPrice(price, tokenOut))
          setDisplayPriceInput(formatPrice(internalToDisplay(price), priceInverted ? tokenIn : tokenOut))
        }
      } catch { /* silent */ }
      setLoadingPrice(false)
    }
    fetchPrice()
  }, [tokenIn?.address, tokenOut?.address])

  // Sync display input when toggling price direction
  useEffect(() => {
    const internal = parseFloat(targetPrice)
    if (!isNaN(internal) && internal > 0) {
      const dp = internalToDisplay(internal)
      setDisplayPriceInput(formatPrice(dp, quoteToken))
    }
  }, [priceInverted])

  // ── Display price input handler ──────────────────────────
  const handleDisplayPriceChange = (rawInput: string) => {
    setDisplayPriceInput(rawInput)
    if (!rawInput) {
      setTargetPrice('')
      return
    }
    const dp = parseFloat(rawInput)
    if (isNaN(dp) || dp <= 0) return
    const internal = displayToInternal(dp)
    setTargetPrice(internal.toString())
  }

  // Set internal price and sync display
  const setInternalPrice = useCallback((internal: number) => {
    setTargetPrice(formatPrice(internal, tokenOut))
    const dp = internalToDisplay(internal)
    setDisplayPriceInput(formatPrice(dp, quoteToken))
  }, [tokenOut, quoteToken, internalToDisplay])

  // ── Percentage adjustment ────────────────────────────────
  const applyPercentAdjust = (percent: number) => {
    if (marketPrice <= 0) return
    playClick()
    const adjusted = marketPrice * (1 + percent / 100)
    setInternalPrice(adjusted)
  }

  // ── Toggle price direction ───────────────────────────────
  const togglePriceDirection = () => {
    setPriceInverted(prev => !prev)
    playClick()
  }

  // Compute buy amount preview
  const buyPreview = useMemo(() => {
    if (!amount || !targetPrice) return ''
    try {
      const sellRaw = parseUnits(amount, tokenIn.decimals)
      const price = parseFloat(targetPrice)
      if (price <= 0) return ''
      const buyRaw = Number(sellRaw) * price / (10 ** tokenIn.decimals)
      return buyRaw.toFixed(tokenOut.decimals <= 6 ? 2 : 6)
    } catch { return '' }
  }, [amount, targetPrice, tokenIn, tokenOut])

  // Price difference from market (always in internal terms)
  const priceDiffPercent = useMemo(() => {
    if (!targetPrice || !marketPrice) return null
    const target = parseFloat(targetPrice)
    if (target <= 0 || marketPrice <= 0) return null
    return ((target - marketPrice) / marketPrice) * 100
  }, [targetPrice, marketPrice])

  // Contextual label: selling stablecoin for crypto = "Buy below" intent
  const orderIntent = useMemo(() => {
    const sellIsStable = isStablecoin(tokenIn)
    const buyIsStable = isStablecoin(tokenOut)
    if (sellIsStable && !buyIsStable) {
      // "Buy ETH with USDC" — user wants to buy below market
      return { label: 'Buy below', hint: `Buy ${tokenOut.symbol} when price drops` }
    }
    if (!sellIsStable && buyIsStable) {
      // "Sell ETH for USDC" — user wants to sell above market (take profit)
      return { label: 'Take profit', hint: `Sell ${tokenIn.symbol} when price rises` }
    }
    return null
  }, [tokenIn, tokenOut])

  const handleSubmit = async () => {
    if (!amount || !targetPrice || !isConnected) return
    playClick()

    const rawAmount = parseUnits(amount, tokenIn.decimals).toString()
    const config: LimitOrderConfig = {
      tokenIn,
      tokenOut,
      sellAmount: rawAmount,
      targetPrice: parseFloat(targetPrice), // always internal (tokenOut per tokenIn)
      kind: 'sell',
      expirySeconds: LIMIT_EXPIRY_PRESETS[expiryIdx].seconds,
      partiallyFillable: partialFill,
      slippage: 0,
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

  // Swap sell ↔ buy tokens
  const handleSwapTokens = () => {
    playClick()
    const prevIn = tokenIn
    const prevOut = tokenOut
    setTokenIn(prevOut)
    setTokenOut(prevIn)
    clearPrice()
  }

  // Use market price button
  const setMarketAsTarget = () => {
    if (marketPrice > 0) {
      setInternalPrice(marketPrice)
      playClick()
    }
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
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
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
          {LIMIT_EXPIRY_PRESETS.map((preset, i) => (
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

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="mb-2 text-[11px] text-cream-35 hover:text-cream"
      >
        {showAdvanced ? '▾ Hide advanced' : '▸ Advanced options'}
      </button>

      {showAdvanced && (
        <div className="mb-3 rounded-lg border border-cream-08 bg-surface-tertiary p-3">
          <label className="flex items-center gap-2 text-xs text-cream-65">
            <input
              type="checkbox"
              checked={partialFill}
              onChange={(e) => setPartialFill(e.target.checked)}
              className="accent-cream-gold"
            />
            Allow partial fills
          </label>
          <p className="mt-1 text-[10px] text-cream-35">
            If enabled, the order can be filled across multiple solver batches.
          </p>
        </div>
      )}

      {/* Submit */}
      {!isConnected ? (
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      ) : (
        <button
          onClick={handleSubmit}
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
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2">
        <span className="text-[10px] text-cream-35">
          Powered by CoW Protocol — zero gas fees, MEV-protected, solvers compete to fill your order at the best price.
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
  onRemove,
}: {
  active: import('@/lib/limit-order-types').LimitOrder[]
  history: import('@/lib/limit-order-types').LimitOrder[]
  onCancel: (id: string) => void
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
          <h4 className="text-xs font-semibold text-cream-50">Active Orders</h4>
          {active.map(order => (
            <OrderCard key={order.id} order={order} onCancel={onCancel} />
          ))}
        </>
      )}

      {history.length > 0 && (
        <>
          <h4 className="mt-3 text-xs font-semibold text-cream-50">History</h4>
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
  order: import('@/lib/limit-order-types').LimitOrder
  onCancel?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  const statusColors: Record<string, string> = {
    signing: 'text-yellow-400',
    open: 'text-blue-400',
    partiallyFilled: 'text-cyan-400',
    fulfilled: 'text-green-400',
    expired: 'text-cream-35',
    cancelled: 'text-cream-35',
    error: 'text-red-400',
  }

  const statusLabels: Record<string, string> = {
    signing: 'Signing...',
    open: 'Open',
    partiallyFilled: `Filled ${order.filledPercent}%`,
    fulfilled: 'Filled',
    expired: 'Expired',
    cancelled: 'Cancelled',
    error: 'Failed',
  }

  const sellFormatted = formatUnits(
    BigInt(order.config.sellAmount),
    order.config.tokenIn.decimals,
  )
  const buyFormatted = formatUnits(
    BigInt(order.buyAmount),
    order.config.tokenOut.decimals,
  )

  const timeLeft = order.validTo * 1000 - Date.now()
  const hoursLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60)))
  const daysLeft = Math.floor(hoursLeft / 24)

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-secondary p-3">
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={order.config.tokenIn.logoURI} alt="" className="h-5 w-5 rounded-full" />
          <span className="text-sm font-medium text-cream">
            {Number(sellFormatted).toFixed(4)} {order.config.tokenIn.symbol}
          </span>
          <span className="text-cream-35">→</span>
          <img src={order.config.tokenOut.logoURI} alt="" className="h-5 w-5 rounded-full" />
          <span className="text-sm font-medium text-cream">
            {Number(buyFormatted).toFixed(4)} {order.config.tokenOut.symbol}
          </span>
        </div>
        <span className={`text-[11px] font-semibold ${statusColors[order.status] || 'text-cream-50'}`}>
          {statusLabels[order.status] || order.status}
        </span>
      </div>

      {/* Price + expiry */}
      <div className="mb-2 flex items-center justify-between text-[11px] text-cream-50">
        <span>@ {order.config.targetPrice.toFixed(tokenPriceDecimals(order.config.tokenOut))} {order.config.tokenOut.symbol}/{order.config.tokenIn.symbol}</span>
        {order.status === 'open' && timeLeft > 0 && (
          <span>{daysLeft > 0 ? `${daysLeft}d ${hoursLeft % 24}h` : `${hoursLeft}h`} left</span>
        )}
      </div>

      {/* Fill progress bar */}
      {(order.status === 'open' || order.status === 'partiallyFilled') && order.filledPercent > 0 && (
        <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
          <div
            className="h-full rounded-full bg-cream-gold transition-all"
            style={{ width: `${order.filledPercent}%` }}
          />
        </div>
      )}

      {/* Error */}
      {order.error && (
        <p className="mb-2 text-[11px] text-red-400">{order.error}</p>
      )}

      {/* Tx hash */}
      {order.txHash && (
        <a
          href={`https://etherscan.io/tx/${order.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-2 block text-[11px] text-cream-gold hover:underline"
        >
          View on Etherscan ↗
        </a>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        {onCancel && (order.status === 'open' || order.status === 'partiallyFilled') && (
          <button
            onClick={() => { onCancel(order.id); playClick() }}
            className="rounded-lg border border-cream-08 px-3 py-1.5 text-[11px] text-cream-50 transition hover:border-red-400 hover:text-red-400"
          >
            Cancel
          </button>
        )}
        {onRemove && (order.status === 'fulfilled' || order.status === 'expired' || order.status === 'cancelled' || order.status === 'error') && (
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
  // For stablecoin quotes (USDC, USDT etc.), use 2 decimals
  if (isStablecoin(quoteToken)) return value.toFixed(2)
  // For very small values (< 0.001) use more decimals
  if (value < 0.001) return value.toFixed(8)
  if (value < 1) return value.toFixed(6)
  return value.toFixed(quoteToken.decimals <= 6 ? 2 : 6)
}

// ── Helper: decimals for price display ─────────────────────
function tokenPriceDecimals(token: Token): number {
  return token.decimals <= 6 ? 2 : 6
}
