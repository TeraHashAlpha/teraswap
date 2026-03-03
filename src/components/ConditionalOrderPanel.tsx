'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useConditionalOrder } from '@/hooks/useConditionalOrder'
import { getTokenPriceUSD } from '@/lib/price-monitor'
import { fetchCurrentPrice } from '@/lib/limit-order-api'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import { LIMIT_EXPIRY_PRESETS } from '@/lib/limit-order-types'
import type { ConditionalOrderConfig, ConditionalOrderType, ConditionalOrder } from '@/lib/conditional-order-types'
import { playClick, playLimitPlaced, playTriggerAlert, playApproval, playError } from '@/lib/sounds'
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

// ══════════════════════════════════════════════════════════
//  MAIN PANEL
// ══════════════════════════════════════════════════════════
export default function ConditionalOrderPanel() {
  const [tab, setTab] = useState<'create' | 'orders'>('create')
  const { activeOrders, historyOrders, latestEvent, createOrder, cancelOrder, removeOrder } = useConditionalOrder()
  const { address } = useAccount()

  const { toast } = useToast()

  // Sound effects + toasts
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'price_triggered') {
      playTriggerAlert()
      toast({ type: 'warning', title: 'Price trigger hit!', description: `Price reached $${latestEvent.price.toFixed(2)} — submitting order...`, duration: 6000 })
    }
    if (latestEvent.type === 'order_submitted') {
      playLimitPlaced()
      toast({ type: 'info', title: 'Order submitted', description: 'CoW solvers are working on your fill.' })
    }
    if (latestEvent.type === 'order_filled') {
      playApproval()
      toast({ type: 'success', title: 'Order filled!', description: 'Your conditional order executed successfully.', txHash: latestEvent.txHash, duration: 10000 })
      if (address) {
        trackTrade({
          type: 'sltp_trigger',
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
      toast({ type: 'error', title: 'Order failed', description: latestEvent.error || 'The conditional order could not execute.' })
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
          New SL / TP
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
        <CreateConditionalForm onSubmit={createOrder} />
      ) : (
        <ConditionalOrdersList
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
//  CREATE FORM
// ══════════════════════════════════════════════════════════
function CreateConditionalForm({
  onSubmit,
}: {
  onSubmit: (config: ConditionalOrderConfig) => Promise<void>
}) {
  const { address, isConnected } = useAccount()

  const [orderType, setOrderType] = useState<ConditionalOrderType>('stop_loss')
  const [tokenIn, setTokenIn] = useState<Token>(DEFAULT_TOKENS[0])   // ETH
  const [tokenOut, setTokenOut] = useState<Token>(DEFAULT_TOKENS[2])  // USDC
  const [amount, setAmount] = useState('')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [expiryIdx, setExpiryIdx] = useState(2)
  const [partialFill, setPartialFill] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Live USD price of tokenIn
  const [currentUsdPrice, setCurrentUsdPrice] = useState<number>(0)
  const [loadingPrice, setLoadingPrice] = useState(false)

  // Market price in tokenOut per tokenIn (for limit order)
  const [marketPrice, setMarketPrice] = useState<number>(0)

  // Fetch current USD price of tokenIn
  useEffect(() => {
    if (!tokenIn) return
    setLoadingPrice(true)
    getTokenPriceUSD(tokenIn.address).then(p => {
      setCurrentUsdPrice(p)
      setLoadingPrice(false)
    }).catch(() => setLoadingPrice(false))
  }, [tokenIn?.address])

  // Fetch market price (tokenOut per tokenIn)
  useEffect(() => {
    if (!tokenIn || !tokenOut) return
    const fetchMkt = async () => {
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
      } catch { /* silent */ }
    }
    fetchMkt()
  }, [tokenIn?.address, tokenOut?.address])

  // Auto-fill trigger price based on type
  useEffect(() => {
    if (currentUsdPrice > 0 && !triggerPrice) {
      if (orderType === 'stop_loss') {
        // Default SL: 10% below current
        setTriggerPrice((currentUsdPrice * 0.9).toFixed(2))
      } else {
        // Default TP: 20% above current
        setTriggerPrice((currentUsdPrice * 1.2).toFixed(2))
      }
    }
  }, [currentUsdPrice, orderType])

  // Price diff from current
  const priceDiffPercent = useMemo(() => {
    const trigger = parseFloat(triggerPrice)
    if (!trigger || !currentUsdPrice) return null
    return ((trigger - currentUsdPrice) / currentUsdPrice) * 100
  }, [triggerPrice, currentUsdPrice])

  // Limit price (slightly worse than market to ensure fill)
  const limitPrice = useMemo(() => {
    if (marketPrice <= 0) return 0
    // For SL: set limit price 2% below market (accept slightly worse fill)
    // For TP: set limit price at market (or slightly above)
    if (orderType === 'stop_loss') return marketPrice * 0.98
    return marketPrice * 1.0
  }, [marketPrice, orderType])

  const handleSubmit = async () => {
    if (!amount || !triggerPrice || !isConnected || limitPrice <= 0) return
    playClick()
    setIsSubmitting(true)

    try {
      const rawAmount = parseUnits(amount, tokenIn.decimals).toString()
      const config: ConditionalOrderConfig = {
        type: orderType,
        tokenIn,
        tokenOut,
        sellAmount: rawAmount,
        triggerPrice: parseFloat(triggerPrice),
        triggerDirection: orderType === 'stop_loss' ? 'below' : 'above',
        limitPrice,
        expirySeconds: LIMIT_EXPIRY_PRESETS[expiryIdx].seconds,
        partiallyFillable: partialFill,
      }
      await onSubmit(config)
      setAmount('')
      setTriggerPrice('')
    } catch { /* handled in hook */ }
    setIsSubmitting(false)
  }

  const handleTokenInSelect = (token: Token) => {
    if (token.address === tokenOut.address) setTokenOut(tokenIn)
    setTokenIn(token)
    setTriggerPrice('')
    setCurrentUsdPrice(0)
    setMarketPrice(0)
  }

  const handleTokenOutSelect = (token: Token) => {
    if (token.address === tokenIn.address) setTokenIn(tokenOut)
    setTokenOut(token)
    setMarketPrice(0)
  }

  const handleSwapTokens = () => {
    playClick()
    const prevIn = tokenIn
    const prevOut = tokenOut
    setTokenIn(prevOut)
    setTokenOut(prevIn)
    setTriggerPrice('')
    setCurrentUsdPrice(0)
    setMarketPrice(0)
  }

  // Quick percentage buttons for trigger price
  const applyPercentToTrigger = (percent: number) => {
    if (currentUsdPrice <= 0) return
    playClick()
    setTriggerPrice((currentUsdPrice * (1 + percent / 100)).toFixed(2))
  }

  const slPresets = [
    { label: '-5%', value: -5 },
    { label: '-10%', value: -10 },
    { label: '-15%', value: -15 },
    { label: '-20%', value: -20 },
  ]
  const tpPresets = [
    { label: '+10%', value: 10 },
    { label: '+25%', value: 25 },
    { label: '+50%', value: 50 },
    { label: '+100%', value: 100 },
  ]
  const presets = orderType === 'stop_loss' ? slPresets : tpPresets

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      {/* SL / TP toggle */}
      <div className="mb-4 flex gap-1 rounded-lg border border-cream-08 bg-surface-tertiary p-0.5">
        <button
          onClick={() => { setOrderType('stop_loss'); setTriggerPrice(''); playClick() }}
          className={`flex-1 rounded-md py-2 text-[12px] font-semibold transition ${
            orderType === 'stop_loss'
              ? 'bg-red-500/20 text-red-400 border border-red-500/30'
              : 'text-cream-50 hover:text-cream border border-transparent'
          }`}
        >
          Stop Loss
        </button>
        <button
          onClick={() => { setOrderType('take_profit'); setTriggerPrice(''); playClick() }}
          className={`flex-1 rounded-md py-2 text-[12px] font-semibold transition ${
            orderType === 'take_profit'
              ? 'bg-green-500/20 text-green-400 border border-green-500/30'
              : 'text-cream-50 hover:text-cream border border-transparent'
          }`}
        >
          Take Profit
        </button>
      </div>

      {/* Intent explanation */}
      <div className="mb-3 rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2">
        <span className={`text-[11px] font-semibold ${orderType === 'stop_loss' ? 'text-red-400' : 'text-green-400'}`}>
          {orderType === 'stop_loss' ? 'Stop Loss' : 'Take Profit'}
        </span>
        <span className="ml-1.5 text-[10px] text-cream-50">
          {orderType === 'stop_loss'
            ? `Sell ${tokenIn.symbol} automatically if price drops to your target`
            : `Sell ${tokenIn.symbol} automatically when price rises to your target`}
        </span>
      </div>

      {/* Sell token + amount */}
      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          {orderType === 'stop_loss' ? 'Protect' : 'Take profit on'}
        </label>
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

      {/* Swap direction */}
      <div className="my-2 flex justify-center">
        <button
          onClick={handleSwapTokens}
          className="rounded-full border border-cream-08 bg-surface-primary p-1.5 text-cream-50 transition-all hover:border-cream-35 hover:text-cream active:scale-90"
          title="Swap tokens"
        >
          ⇅
        </button>
      </div>

      {/* Receive token */}
      <div className="mb-4">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">Receive</label>
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-primary px-3 py-2.5">
          <TokenSelector selected={tokenOut} onSelect={handleTokenOutSelect} disabledAddress={tokenIn?.address} />
          <span className="flex-1 text-right text-sm text-cream-35">
            {marketPrice > 0 && amount
              ? `≈ ${(parseFloat(amount) * marketPrice).toFixed(isStablecoin(tokenOut) ? 2 : 6)}`
              : 'Set trigger price below'}
          </span>
        </div>
      </div>

      {/* Current price display */}
      {currentUsdPrice > 0 && (
        <div className="mb-2 flex items-center justify-between rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2">
          <span className="text-[11px] text-cream-50">Current {tokenIn.symbol} price</span>
          <span className="text-[12px] font-semibold text-cream">${currentUsdPrice.toFixed(2)}</span>
        </div>
      )}

      {/* Trigger price */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-cream-50">
            Trigger at (USD)
          </label>
          {currentUsdPrice > 0 && (
            <span className="text-[10px] text-cream-35">
              Current: ${currentUsdPrice.toFixed(2)}
            </span>
          )}
        </div>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-cream-35">$</span>
          <input
            type="number"
            step="any"
            placeholder={loadingPrice ? 'Loading...' : '0.00'}
            value={triggerPrice}
            onChange={(e) => setTriggerPrice(e.target.value)}
            className="w-full rounded-lg border border-cream-08 bg-surface-tertiary py-2.5 pl-7 pr-3 text-sm text-cream outline-none focus:border-cream-35"
          />
        </div>

        {/* Percentage presets */}
        {currentUsdPrice > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.value}
                onClick={() => applyPercentToTrigger(p.value)}
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
              : priceDiffPercent < 0
                ? 'text-red-400'
                : 'text-cream-50'
          }`}>
            {priceDiffPercent > 0 ? '+' : ''}{priceDiffPercent.toFixed(2)}% from current price
          </p>
        )}
      </div>

      {/* Expiry (after trigger) */}
      <div className="mb-3">
        <label className="mb-1 block text-xs text-cream-50">Order expires (after trigger)</label>
        <div className="flex gap-1.5">
          {LIMIT_EXPIRY_PRESETS.slice(0, 3).map((preset, i) => (
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
          onClick={handleSubmit}
          disabled={isSubmitting || !amount || !triggerPrice}
          className={`w-full rounded-xl py-3 text-sm font-bold transition-all ${
            isSubmitting || !amount || !triggerPrice
              ? 'cursor-not-allowed bg-cream-08 text-cream-35'
              : orderType === 'stop_loss'
                ? 'bg-red-500/80 text-white hover:bg-red-500 active:scale-[0.98]'
                : 'bg-green-500/80 text-white hover:bg-green-500 active:scale-[0.98]'
          }`}
        >
          {isSubmitting
            ? 'Creating...'
            : orderType === 'stop_loss'
              ? `Set Stop Loss at $${triggerPrice || '—'}`
              : `Set Take Profit at $${triggerPrice || '—'}`}
        </button>
      )}

      {/* Info badge */}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-cream-08 bg-surface-tertiary px-3 py-2">
        <span className="text-[10px] text-cream-35">
          Price monitored via Chainlink oracles. When triggered, a CoW Protocol limit order is
          auto-submitted for MEV-protected execution.
        </span>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  ORDERS LIST
// ══════════════════════════════════════════════════════════
function ConditionalOrdersList({
  active,
  history,
  onCancel,
  onRemove,
}: {
  active: ConditionalOrder[]
  history: ConditionalOrder[]
  onCancel: (id: string) => void
  onRemove: (id: string) => void
}) {
  if (active.length === 0 && history.length === 0) {
    return (
      <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-6 text-center text-sm text-cream-50">
        No stop loss or take profit orders yet.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {active.length > 0 && (
        <>
          <h4 className="text-xs font-semibold text-cream-50">Active</h4>
          {active.map(order => (
            <ConditionalOrderCard key={order.id} order={order} onCancel={onCancel} />
          ))}
        </>
      )}

      {history.length > 0 && (
        <>
          <h4 className="mt-3 text-xs font-semibold text-cream-50">History</h4>
          {history.map(order => (
            <ConditionalOrderCard key={order.id} order={order} onRemove={onRemove} />
          ))}
        </>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  ORDER CARD
// ══════════════════════════════════════════════════════════
function ConditionalOrderCard({
  order,
  onCancel,
  onRemove,
}: {
  order: ConditionalOrder
  onCancel?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  const isSL = order.config.type === 'stop_loss'
  const typeColor = isSL ? 'text-red-400' : 'text-green-400'
  const typeLabel = isSL ? 'Stop Loss' : 'Take Profit'

  const statusColors: Record<string, string> = {
    monitoring: 'text-blue-400',
    triggered: 'text-yellow-400',
    submitted: 'text-cyan-400',
    filled: 'text-green-400',
    partiallyFilled: 'text-cyan-400',
    expired: 'text-cream-35',
    cancelled: 'text-cream-35',
    error: 'text-red-400',
  }

  const statusLabels: Record<string, string> = {
    monitoring: 'Watching...',
    triggered: 'Triggered!',
    submitted: 'Order placed',
    filled: 'Filled',
    partiallyFilled: `Filled ${order.filledPercent}%`,
    expired: 'Expired',
    cancelled: 'Cancelled',
    error: 'Failed',
  }

  const sellFormatted = formatUnits(
    BigInt(order.config.sellAmount),
    order.config.tokenIn.decimals,
  )

  // Distance from trigger
  const distancePercent = order.currentPrice > 0 && order.triggerPrice > 0
    ? ((order.currentPrice - order.triggerPrice) / order.currentPrice) * 100
    : null

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-secondary p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-bold ${typeColor}`}>{typeLabel}</span>
          <img src={order.config.tokenIn.logoURI} alt="" className="h-4 w-4 rounded-full" />
          <span className="text-sm font-medium text-cream">
            {Number(sellFormatted).toFixed(4)} {order.config.tokenIn.symbol}
          </span>
          <span className="text-cream-35">→</span>
          <img src={order.config.tokenOut.logoURI} alt="" className="h-4 w-4 rounded-full" />
          <span className="text-sm text-cream-50">{order.config.tokenOut.symbol}</span>
        </div>
        <span className={`text-[11px] font-semibold ${statusColors[order.status] || 'text-cream-50'}`}>
          {statusLabels[order.status] || order.status}
        </span>
      </div>

      {/* Prices */}
      <div className="mb-2 flex items-center justify-between text-[11px] text-cream-50">
        <span>Trigger: ${order.triggerPrice.toFixed(2)}</span>
        {order.status === 'monitoring' && order.currentPrice > 0 && (
          <span>Now: ${order.currentPrice.toFixed(2)}</span>
        )}
      </div>

      {/* Distance from trigger (for monitoring) */}
      {order.status === 'monitoring' && distancePercent !== null && (
        <div className="mb-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-cream-35">Distance to trigger</span>
            <span className={Math.abs(distancePercent) < 3 ? 'text-yellow-400' : 'text-cream-50'}>
              {Math.abs(distancePercent).toFixed(2)}%
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
            <div
              className={`h-full rounded-full transition-all ${
                Math.abs(distancePercent) < 3
                  ? 'bg-yellow-400'
                  : isSL ? 'bg-red-400/50' : 'bg-green-400/50'
              }`}
              style={{ width: `${Math.min(100, 100 - Math.abs(distancePercent))}%` }}
            />
          </div>
        </div>
      )}

      {/* Fill progress */}
      {(order.status === 'submitted' || order.status === 'partiallyFilled') && order.filledPercent > 0 && (
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
        {onCancel && (order.status === 'monitoring' || order.status === 'submitted') && (
          <button
            onClick={() => { onCancel(order.id); playClick() }}
            className="rounded-lg border border-cream-08 px-3 py-1.5 text-[11px] text-cream-50 transition hover:border-red-400 hover:text-red-400"
          >
            Cancel
          </button>
        )}
        {onRemove && (order.status === 'filled' || order.status === 'expired' || order.status === 'cancelled' || order.status === 'error') && (
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
