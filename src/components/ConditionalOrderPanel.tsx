'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import { getTokenPriceUSD } from '@/lib/price-monitor'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import {
  OrderType,
  PriceCondition,
  EXPIRY_PRESETS,
  getDefaultRouter,
  getChainlinkFeeds,
} from '@/lib/order-engine'
import type { CreateOrderConfig, AutonomousOrder } from '@/lib/order-engine'
import { playClick, playTouchMP3, playSwapConfirmMP3, playTriggerAlert, playCancelOrderMP3, playError, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import { ETHERSCAN_TX } from '@/lib/constants'
import TokenSelector from './TokenSelector'

// ── Stablecoin detection ─────────────────────────────────
const STABLECOIN_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'PYUSD', 'USDe', 'USDS',
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

type ConditionalOrderType = 'stop_loss' | 'take_profit'

// ══════════════════════════════════════════════════════════
//  MAIN PANEL
// ══════════════════════════════════════════════════════════
export default function ConditionalOrderPanel() {
  const [tab, setTab] = useState<'create' | 'orders'>('create')
  const { stopLossOrders, latestEvent, isSubmitting, createOrder, cancelOrder, removeOrder } = useOrderEngine()
  const { address } = useAccount()
  const chainId = useChainId()

  const { toast } = useToast()

  // Browser push notifications (fires when tab is in background)
  useOrderNotifications(latestEvent)

  // Sound effects + toasts
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'order_created') {
      stopWaitingSound()
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'Order placed', description: 'Chainlink oracles are monitoring your trigger price. Your order will execute automatically.' })
    }
    if (latestEvent.type === 'order_filled') {
      playSwapConfirmMP3()
      toast({ type: 'success', title: 'Order filled!', description: 'Your conditional order executed successfully.', txHash: latestEvent.txHash, duration: 10000 })
      if (address) {
        trackTrade({
          type: 'sltp_trigger',
          wallet: address,
          tokenIn: '', tokenInAddress: '',
          tokenOut: '', tokenOutAddress: '',
          amountIn: '0', amountOut: '0',
          volumeUsd: 0,
          source: 'teraswap_order_engine', txHash: latestEvent.txHash || '',
        })
      }
    }
    if (latestEvent.type === 'order_error') {
      stopWaitingSound()
      playCancelOrderMP3()
      toast({ type: 'error', title: 'Order failed', description: latestEvent.error || 'The conditional order could not execute.' })
    }
  }, [latestEvent, address])

  const activeSLTP = stopLossOrders.filter(o =>
    o.status === 'active' || o.status === 'executing' || o.status === 'signing'
  )
  const historySLTP = stopLossOrders.filter(o =>
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
          Orders{activeSLTP.length > 0 && ` (${activeSLTP.length})`}
        </button>
      </div>

      {tab === 'create' ? (
        <CreateConditionalForm onSubmit={createOrder} isSubmitting={isSubmitting} />
      ) : (
        <ConditionalOrdersList
          active={activeSLTP}
          history={historySLTP}
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
  isSubmitting,
}: {
  onSubmit: (config: CreateOrderConfig) => Promise<void>
  isSubmitting: boolean
}) {
  const { isConnected } = useAccount()
  const chainId = useChainId()

  const [orderType, setOrderType] = useState<ConditionalOrderType>('stop_loss')
  const [tokenIn, setTokenIn] = useState<Token>(DEFAULT_TOKENS[0])   // ETH
  const [tokenOut, setTokenOut] = useState<Token>(DEFAULT_TOKENS[2])  // USDC
  const [amount, setAmount] = useState('')
  const [triggerPrice, setTriggerPrice] = useState('')
  const [expiryIdx, setExpiryIdx] = useState(3) // 30d default

  // Live USD price of tokenIn
  const [currentUsdPrice, setCurrentUsdPrice] = useState<number>(0)
  const [loadingPrice, setLoadingPrice] = useState(false)

  // Fetch current USD price of tokenIn
  useEffect(() => {
    if (!tokenIn) return
    setLoadingPrice(true)
    getTokenPriceUSD(tokenIn.address).then(p => {
      setCurrentUsdPrice(p)
      setLoadingPrice(false)
    }).catch(() => {
      setCurrentUsdPrice(0)
      setLoadingPrice(false)
    })
  }, [tokenIn?.address])

  // Auto-fill trigger price based on type
  const DEFAULT_SL_FACTOR = 0.9  // 10% below current
  const DEFAULT_TP_FACTOR = 1.2  // 20% above current
  useEffect(() => {
    if (currentUsdPrice > 0 && !triggerPrice) {
      const factor = orderType === 'stop_loss' ? DEFAULT_SL_FACTOR : DEFAULT_TP_FACTOR
      setTriggerPrice((currentUsdPrice * factor).toFixed(2))
    }
  }, [currentUsdPrice, orderType])

  // Price diff from current
  const priceDiffPercent = useMemo(() => {
    const trigger = parseFloat(triggerPrice)
    if (!trigger || !currentUsdPrice) return null
    return ((trigger - currentUsdPrice) / currentUsdPrice) * 100
  }, [triggerPrice, currentUsdPrice])

  const handleSubmit = async () => {
    if (!amount || !triggerPrice || !isConnected) return
    startWaitingSound()

    let amountIn: string
    try {
      amountIn = parseUnits(amount, tokenIn.decimals).toString()
    } catch {
      return // Invalid input (e.g. too many decimals)
    }
    const triggerPriceFloat = parseFloat(triggerPrice)

    // Target price in Chainlink 8-decimal format
    const targetPrice8dec = Math.round(triggerPriceFloat * 1e8).toString()

    // Condition: SL → triggers when price drops BELOW target, TP → triggers when ABOVE
    const condition = orderType === 'stop_loss'
      ? PriceCondition.BELOW
      : PriceCondition.ABOVE

    // Min amount out: for SL accept 5% slippage (urgent exit), for TP accept 2%
    // [BUGFIX] Use BigInt arithmetic to avoid precision loss beyond 2^53
    const slippageBps = orderType === 'stop_loss' ? 95n : 98n // 95% or 98% of expected
    const amountInBn = BigInt(amountIn)
    const priceBn = BigInt(Math.round(triggerPriceFloat * 1e18))
    const expectedOutRaw = amountInBn * priceBn / BigInt(1e18)
    // Adjust for decimal difference between tokenIn and tokenOut
    const decDiff = tokenOut.decimals - tokenIn.decimals
    const expectedOutAdjusted = decDiff > 0
      ? expectedOutRaw * BigInt(10 ** decDiff)
      : decDiff < 0
        ? expectedOutRaw / BigInt(10 ** Math.abs(decDiff))
        : expectedOutRaw
    const minAmountOut = (expectedOutAdjusted * slippageBps / 100n).toString()

    const config: CreateOrderConfig = {
      tokenIn: { address: tokenIn.address, symbol: tokenIn.symbol, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, symbol: tokenOut.symbol, decimals: tokenOut.decimals },
      amountIn,
      minAmountOut,
      orderType: OrderType.STOP_LOSS, // Contract uses STOP_LOSS for both SL and TP
      condition,
      targetPrice: targetPrice8dec,
      priceFeed: findPriceFeed(tokenIn, chainId), // Monitor the sell token price
      expirySeconds: EXPIRY_PRESETS[expiryIdx].seconds,
      router: getDefaultRouter(chainId).address,
    }

    await onSubmit(config)
    setAmount('')
    setTriggerPrice('')
  }

  const handleTokenInSelect = (token: Token) => {
    if (token.address === tokenOut.address) setTokenOut(tokenIn)
    setTokenIn(token)
    setTriggerPrice('')
    setCurrentUsdPrice(0)
  }

  const handleTokenOutSelect = (token: Token) => {
    if (token.address === tokenIn.address) setTokenIn(tokenOut)
    setTokenOut(token)
  }

  const handleSwapTokens = () => {
    playClick()
    const prevIn = tokenIn
    const prevOut = tokenOut
    setTokenIn(prevOut)
    setTokenOut(prevIn)
    setTriggerPrice('')
    setCurrentUsdPrice(0)
  }

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
            // [BUGFIX] Prevent multiple decimal points (old regex /[^0-9.]/g allowed "1.2.3")
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              const parts = v.split('.')
              setAmount(parts.length > 2 ? parts[0] + '.' + parts.slice(1).join('') : v)
            }}
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
            {currentUsdPrice > 0 && amount
              ? `≈ ${(parseFloat(amount) * parseFloat(triggerPrice || '0')).toFixed(isStablecoin(tokenOut) ? 2 : 6)}`
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

      {/* Expiry */}
      <div className="mb-3">
        <label className="mb-1 block text-xs text-cream-50">Order expires</label>
        <div className="flex gap-1.5">
          {EXPIRY_PRESETS.slice(1, 5).map((preset, i) => (
            <button
              key={preset.seconds}
              onClick={() => { setExpiryIdx(i + 1); playClick() }}
              className={`flex-1 rounded-lg py-2 text-[11px] font-medium transition ${
                expiryIdx === i + 1
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
            ? 'Signing order...'
            : orderType === 'stop_loss'
              ? `Set Stop Loss at $${triggerPrice || '—'}`
              : `Set Take Profit at $${triggerPrice || '—'}`}
        </button>
      )}

      {/* Info badge */}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2">
        <span className="text-[10px] text-cream-50">
          <span className="font-semibold text-cream-gold">Autonomous execution</span> — Chainlink oracles monitor price on-chain. Your order executes automatically when target is hit. Sign once, no browser needed.
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
  active: AutonomousOrder[]
  history: AutonomousOrder[]
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
  order: AutonomousOrder
  onCancel?: (id: string) => void
  onRemove?: (id: string) => void
}) {
  // Determine if SL or TP based on condition
  const isSL = order.order?.condition === PriceCondition.BELOW
  const typeColor = isSL ? 'text-red-400' : 'text-green-400'
  const typeLabel = isSL ? 'Stop Loss' : 'Take Profit'

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

  // Target price from 8-decimal Chainlink format
  const targetPriceUsd = order.order?.targetPrice
    ? Number(BigInt(order.order.targetPrice.toString())) / 1e8
    : 0

  const isActive = order.status === 'active' || order.status === 'executing' || order.status === 'signing'

  const timeLeft = order.expiresAt - Date.now()
  const daysLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60 * 24)))
  const hoursLeft = Math.max(0, Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)))

  return (
    <div className="rounded-xl border border-cream-08 bg-surface-secondary p-3">
      {/* Header */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-bold ${typeColor}`}>{typeLabel}</span>
          <span className="text-sm font-medium text-cream">
            {Number(amountIn).toFixed(4)} {order.tokenInSymbol}
          </span>
          <span className="text-cream-35">→</span>
          <span className="text-sm text-cream-50">{order.tokenOutSymbol}</span>
        </div>
        <span className={`text-[11px] font-semibold ${statusColors[order.status] || 'text-cream-50'}`}>
          {statusLabels[order.status] || order.status}
        </span>
      </div>

      {/* Trigger price + expiry */}
      <div className="mb-2 flex items-center justify-between text-[11px] text-cream-50">
        <span>Trigger: ${targetPriceUsd.toFixed(2)}</span>
        {isActive && timeLeft > 0 && (
          <span>{daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : `${hoursLeft}h`} left</span>
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
            className="rounded-lg border border-cream-08 px-3 py-1.5 text-[11px] text-cream-50 transition hover:border-red-400 hover:text-red-400"
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
