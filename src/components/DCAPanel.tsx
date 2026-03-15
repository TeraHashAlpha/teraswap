'use client'

import { useState, useMemo, useEffect } from 'react'
import { useAccount, useChainId } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import TokenSelector from './TokenSelector'
import { useOrderEngine } from '@/hooks/useOrderEngine'
import {
  OrderType,
  PriceCondition,
  DCA_INTERVAL_PRESETS,
  DCA_TOTAL_PRESETS,
  EXPIRY_PRESETS,
  getDefaultRouter,
  getChainlinkFeeds,
} from '@/lib/order-engine'
import type { CreateOrderConfig, AutonomousOrder } from '@/lib/order-engine'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import { playClick, playTouchMP3, playSwapConfirmMP3, playCancelOrderMP3, playError, startWaitingSound, stopWaitingSound } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'
import { useOrderNotifications } from '@/hooks/useOrderNotifications'
import { ETHERSCAN_TX } from '@/lib/constants'
import BetaDisclaimer from './BetaDisclaimer'

// ── Map token symbols to Chainlink feeds ─────────────────
// Returns empty string if no feed found — callers must check before submitting.
function findPriceFeed(token: Token, chainId: number): string {
  const feeds = getChainlinkFeeds(chainId)
  const key = `${token.symbol}/USD`
  return feeds[key]?.address ?? ''
}

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
    cancelOrder,
    cancelAllOrders,
    removeOrder,
  } = useOrderEngine()

  const { toast } = useToast()

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
      toast({ type: 'error', title: 'DCA order failed', description: latestEvent.error || 'Order could not be submitted.' })
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
      {/* Tab header */}
      <div className="mb-4 flex gap-1 rounded-xl border border-cream-08 bg-surface-secondary p-1">
        <button
          onClick={() => setTab('create')}
          className={`flex-1 rounded-lg py-2 text-[13px] font-semibold transition-all ${
            tab === 'create'
              ? 'bg-cream-gold text-[#080B10]'
              : 'text-cream-50 hover:text-cream'
          }`}
        >
          New DCA
        </button>
        <button
          onClick={() => setTab('positions')}
          className={`flex-1 rounded-lg py-2 text-[13px] font-semibold transition-all ${
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
          onSubmit={createOrder}
        />
      ) : (
        <DCAPositionsList
          active={activeDCA}
          history={historyDCA}
          onCancel={cancelOrder}
          onCancelAll={cancelAllOrders}
          onRemove={removeOrder}
        />
      )}

      {/* Autonomous notice */}
      <div className="mt-3 rounded-lg border border-cream-gold/20 bg-cream-gold/5 px-3 py-2 text-[11px] text-cream-50">
        <span className="font-semibold text-cream-gold">Autonomous execution</span> — DCA orders run 24/7 via Chainlink oracles. No browser required. Your wallet only signs once.
      </div>

      {/* Beta disclaimer */}
      <BetaDisclaimer />
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  CREATE DCA FORM
// ══════════════════════════════════════════════════════════

function CreateDCAForm({
  isConnected,
  isSubmitting,
  onSubmit,
}: {
  isConnected: boolean
  isSubmitting: boolean
  onSubmit: (config: CreateOrderConfig) => Promise<void>
}) {
  const chainId = useChainId()
  const [tokenIn, setTokenIn] = useState<Token | null>(
    DEFAULT_TOKENS.find(t => t.symbol === 'USDC') ?? null
  )
  const [tokenOut, setTokenOut] = useState<Token | null>(
    DEFAULT_TOKENS.find(t => t.symbol === 'ETH') ?? null
  )
  const [totalDisplay, setTotalDisplay] = useState('')
  const [partsIdx, setPartsIdx] = useState(2) // default: 7
  const [intervalIdx, setIntervalIdx] = useState(3) // default: 1d
  const [expiryIdx, setExpiryIdx] = useState(3) // default: 30d
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [slippage, setSlippage] = useState('0.5')

  const parts = DCA_TOTAL_PRESETS[partsIdx]
  const interval = DCA_INTERVAL_PRESETS[intervalIdx]
  const expiry = EXPIRY_PRESETS[expiryIdx]

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

  const canCreate = isConnected && tokenIn && tokenOut && Number(totalDisplay) > 0 && !isSubmitting

  async function handleCreate() {
    if (!canCreate || !tokenIn || !tokenOut) return
    startWaitingSound()

    let amountIn: string
    try {
      amountIn = parseUnits(totalDisplay, tokenIn.decimals).toString()
    } catch {
      return // Invalid input (e.g. too many decimals)
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
              className={`flex-1 rounded-lg border py-1.5 text-[13px] font-semibold transition-all ${
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
              className={`rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-all ${
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
        className="mb-3 text-[11px] text-cream-35 hover:text-cream-50 transition-colors"
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
                  className={`rounded-lg border px-3 py-1 text-[12px] font-semibold transition-all ${
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

          {/* Expiry */}
          <div className="rounded-xl border border-cream-08 bg-surface-primary p-3">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
              Order expiry
            </label>
            <div className="flex gap-2 flex-wrap">
              {EXPIRY_PRESETS.map((e, idx) => (
                <button
                  key={e.seconds}
                  onClick={() => { setExpiryIdx(idx); playClick() }}
                  className={`rounded-lg border px-3 py-1 text-[12px] font-semibold transition-all ${
                    expiryIdx === idx
                      ? 'border-cream-gold bg-cream-gold/10 text-cream'
                      : 'border-cream-08 text-cream-35 hover:text-cream-50'
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
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

// ══════════════════════════════════════════════════════════
//  DCA POSITIONS LIST
// ══════════════════════════════════════════════════════════

function DCAPositionsList({
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
      <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-8 text-center">
        <p className="text-[15px] text-cream-50">No DCA positions yet</p>
        <p className="mt-1 text-[12px] text-cream-35">Create one to start autonomous dollar cost averaging</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {active.length > 0 && (
        <>
          {active.length > 1 && (
            <div className="flex justify-end">
              <button
                onClick={() => { onCancelAll(); playClick() }}
                className="rounded-lg border border-danger/30 px-2.5 py-1 text-[10px] text-danger/70 hover:text-danger transition-colors"
              >
                Cancel All
              </button>
            </div>
          )}
          {active.map(order => (
            <DCAOrderCard key={order.id} order={order} onCancel={() => { playClick(); onCancel(order.id) }} />
          ))}
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="flex items-center justify-between px-1 pt-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-cream-35">
              History
            </span>
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
            <DCAOrderCard key={order.id} order={order} onRemove={() => { playClick(); onRemove(order.id) }} />
          ))}
        </>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  DCA ORDER CARD
// ══════════════════════════════════════════════════════════

function DCAOrderCard({
  order,
  onCancel,
  onRemove,
}: {
  order: AutonomousOrder
  onCancel?: () => void
  onRemove?: () => void
}) {
  const progress = order.dcaTotal > 0 ? order.dcaExecuted / order.dcaTotal : 0
  const isActive = order.status === 'active' || order.status === 'executing' || order.status === 'partially_filled'

  const statusColor: Record<string, string> = {
    signing: 'bg-yellow-400',
    active: 'bg-success',
    executing: 'bg-blue-400',
    partially_filled: 'bg-cyan-400',
    filled: 'bg-cream-50',
    cancelled: 'bg-danger',
    expired: 'bg-cream-35',
    error: 'bg-danger',
  }

  const statusLabel: Record<string, string> = {
    signing: 'Signing...',
    active: 'Active',
    executing: 'Executing...',
    partially_filled: `${order.dcaExecuted}/${order.dcaTotal} fills`,
    filled: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired',
    error: 'Failed',
  }

  const amountIn = order.order?.amountIn
    ? formatUnits(BigInt(order.order.amountIn.toString()), order.tokenInDecimals)
    : '—'

  // Time remaining
  const timeLeft = order.expiresAt - Date.now()
  const daysLeft = Math.max(0, Math.floor(timeLeft / (1000 * 60 * 60 * 24)))
  const hoursLeft = Math.max(0, Math.floor((timeLeft % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)))

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-cream">
            {order.tokenInSymbol} → {order.tokenOutSymbol}
          </span>
          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            isActive ? 'bg-success/15 text-success' : order.status === 'error' ? 'bg-danger/15 text-danger' : 'bg-cream-08 text-cream-35'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor[order.status] || 'bg-cream-35'}`} />
            {statusLabel[order.status] || order.status}
          </span>
        </div>
        {isActive && onCancel && (
          <button onClick={onCancel} className="rounded-lg border border-danger/30 px-2 py-1 text-[10px] text-danger/70 hover:text-danger transition-colors">
            Cancel
          </button>
        )}
        {!isActive && onRemove && (
          <button onClick={onRemove} className="rounded-lg border border-cream-08 px-2 py-1 text-[10px] text-cream-50 hover:text-cream transition-colors">
            Remove
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mb-2 h-1.5 rounded-full bg-cream-08 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-gold to-gold-light transition-all duration-500"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-cream-35 mb-3">
        <span>{order.dcaExecuted} of {order.dcaTotal} buys</span>
        <span>{Number(amountIn).toFixed(2)} {order.tokenInSymbol} total</span>
      </div>

      {/* Time remaining */}
      {isActive && timeLeft > 0 && (
        <div className="rounded-xl border border-cream-08 bg-surface-primary p-2.5 text-[12px] mb-3">
          <div className="flex justify-between">
            <span className="text-cream-35">Expires in</span>
            <span className="font-semibold text-cream">{daysLeft > 0 ? `${daysLeft}d ${hoursLeft}h` : `${hoursLeft}h`}</span>
          </div>
        </div>
      )}

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
          className="block text-[11px] text-cream-gold hover:underline"
        >
          View on Etherscan ↗
        </a>
      )}
    </div>
  )
}
