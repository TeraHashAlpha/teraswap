'use client'

import { useState, useMemo, useEffect } from 'react'
import { useAccount } from 'wagmi'
import { parseUnits, formatUnits } from 'viem'
import TokenSelector from './TokenSelector'
import { useDCAEngine } from '@/hooks/useDCAEngine'
import { DCA_INTERVALS, type DCAToken } from '@/lib/dca-types'
import { DEFAULT_TOKENS, type Token } from '@/lib/tokens'
import { playClick, playDCABuy, playError } from '@/lib/sounds'
import { trackTrade } from '@/lib/analytics-tracker'
import { useToast } from '@/components/ToastProvider'

// ══════════════════════════════════════════════════════════
//  DCA PANEL — Configuration + Active Positions + Smart Window
// ══════════════════════════════════════════════════════════

export default function DCAPanel() {
  const { address, isConnected } = useAccount()
  const {
    positions,
    activeSnapshots,
    latestEvent,
    createPosition,
    pausePosition,
    resumePosition,
    cancelPosition,
    isReady,
  } = useDCAEngine()

  const { toast } = useToast()

  // ── Sound effects + toasts on events ────────────────────
  useEffect(() => {
    if (!latestEvent) return
    if (latestEvent.type === 'execution_success') {
      playDCABuy()
      toast({ type: 'success', title: 'DCA buy executed', description: `Buy #${latestEvent.executionIndex + 1} completed at best available price.`, txHash: latestEvent.txHash })
      if (address) {
        trackTrade({
          type: 'dca_buy',
          wallet: address,
          tokenIn: '', tokenInAddress: '',
          tokenOut: '', tokenOutAddress: '',
          amountIn: '0', amountOut: '0',
          volumeUsd: 0,
          source: 'uniswapv3',
          txHash: latestEvent.txHash || '',
        })
      }
    }
    if (latestEvent.type === 'execution_failed') {
      playError()
      toast({ type: 'error', title: 'DCA buy failed', description: latestEvent.error || 'Execution was rejected or failed.' })
    }
  }, [latestEvent])

  // ── Tab state ──────────────────────────────────────────
  const [tab, setTab] = useState<'create' | 'positions'>('create')
  const activePositions = positions.filter(p => p.status === 'active' || p.status === 'paused')
  const historyPositions = positions.filter(p => p.status === 'completed' || p.status === 'cancelled')

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
          Positions {activePositions.length > 0 && `(${activePositions.length})`}
        </button>
      </div>

      {tab === 'create' ? (
        <CreateDCAForm
          isConnected={isConnected}
          onCreate={createPosition}
        />
      ) : (
        <PositionsList
          activePositions={activePositions}
          historyPositions={historyPositions}
          activeSnapshots={activeSnapshots}
          onPause={pausePosition}
          onResume={resumePosition}
          onCancel={cancelPosition}
        />
      )}

      {/* Browser notice */}
      <div className="mt-3 rounded-lg border border-cream-08 bg-surface-secondary/50 px-3 py-2 text-[11px] text-cream-35">
        <span className="text-cream-50">Note:</span> DCA executions require your browser to be open.
        Each buy prompts your wallet for confirmation. Fully autonomous DCA via smart contracts is on our roadmap.
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  CREATE DCA FORM
// ══════════════════════════════════════════════════════════

function CreateDCAForm({
  isConnected,
  onCreate,
}: {
  isConnected: boolean
  onCreate: (
    tokenIn: DCAToken,
    tokenOut: DCAToken,
    totalAmount: string,
    numberOfParts: number,
    intervalMs: number,
    slippage?: number,
  ) => void
}) {
  const [tokenIn, setTokenIn] = useState<Token | null>(
    DEFAULT_TOKENS.find(t => t.symbol === 'USDC') ?? null
  )
  const [tokenOut, setTokenOut] = useState<Token | null>(
    DEFAULT_TOKENS.find(t => t.symbol === 'ETH') ?? null
  )
  const [totalDisplay, setTotalDisplay] = useState('')
  const [parts, setParts] = useState('7')
  const [intervalIdx, setIntervalIdx] = useState(3) // default: 1 day
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [slippage, setSlippage] = useState('0.5')

  const interval = DCA_INTERVALS[intervalIdx]

  // Derived values
  const perPart = useMemo(() => {
    const n = Number(parts)
    const total = Number(totalDisplay)
    if (!n || !total || n <= 0) return '0'
    return (total / n).toFixed(tokenIn?.decimals === 6 ? 2 : 6)
  }, [totalDisplay, parts, tokenIn])

  const totalDuration = useMemo(() => {
    const n = Number(parts)
    if (!n || n <= 0) return ''
    const totalMs = n * interval.ms
    const hours = totalMs / (60 * 60 * 1000)
    if (hours < 24) return `${hours.toFixed(0)} hours`
    const days = hours / 24
    if (days < 30) return `${days.toFixed(1)} days`
    return `${(days / 30).toFixed(1)} months`
  }, [parts, interval])

  const canCreate = isConnected && tokenIn && tokenOut && Number(totalDisplay) > 0 && Number(parts) > 0

  function handleCreate() {
    if (!canCreate || !tokenIn || !tokenOut) return
    playClick()

    const rawAmount = parseUnits(totalDisplay, tokenIn.decimals).toString()
    onCreate(
      tokenIn,
      tokenOut,
      rawAmount,
      Number(parts),
      interval.ms,
      Number(slippage),
    )

    // Reset form
    setTotalDisplay('')
    setParts('7')
  }

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      <h3 className="mb-4 text-[15px] font-semibold text-cream">
        Dollar Cost Averaging
      </h3>

      {/* Sell token */}
      <div className="mb-3">
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-cream-35">
          Spend
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
            onChange={e => setTotalDisplay(e.target.value.replace(/[^0-9.]/g, ''))}
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
          {[3, 5, 7, 10, 14, 30].map(n => (
            <button
              key={n}
              onClick={() => { setParts(String(n)); playClick() }}
              className={`flex-1 rounded-lg border py-1.5 text-[13px] font-semibold transition-all ${
                parts === String(n)
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
          {DCA_INTERVALS.map((iv, idx) => (
            <button
              key={iv.ms}
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
      {Number(totalDisplay) > 0 && Number(parts) > 0 && (
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
            <span>Smart window</span>
            <span className="text-cream font-medium">
              Opens {(interval.ms * 0.1 / 60_000).toFixed(0)} min before each buy
            </span>
          </div>
          <div className="mt-2 border-t border-cream-08 pt-2 text-[11px] text-cream-35">
            Each buy uses all 11 DEX sources to find the best price.
            Smart windows monitor Chainlink prices and buy on dips when possible.
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
        <div className="mb-4 rounded-xl border border-cream-08 bg-surface-primary p-3">
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
      )}

      {/* Create button */}
      <button
        disabled={!canCreate}
        onClick={handleCreate}
        className={`w-full rounded-xl py-3 text-[14px] font-bold uppercase tracking-wider transition-all ${
          canCreate
            ? 'bg-gradient-to-r from-gold to-gold-light text-[#080B10] hover:brightness-110 active:scale-[0.98]'
            : 'bg-cream-08 text-cream-20 cursor-not-allowed'
        }`}
      >
        {!isConnected
          ? 'Connect Wallet'
          : !tokenIn || !tokenOut
          ? 'Select Tokens'
          : Number(totalDisplay) <= 0
          ? 'Enter Amount'
          : `Start DCA — ${parts} buys over ${totalDuration}`
        }
      </button>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  POSITIONS LIST
// ══════════════════════════════════════════════════════════

function PositionsList({
  activePositions,
  historyPositions,
  activeSnapshots,
  onPause,
  onResume,
  onCancel,
}: {
  activePositions: import('@/lib/dca-types').DCAPosition[]
  historyPositions: import('@/lib/dca-types').DCAPosition[]
  activeSnapshots: import('@/lib/dca-types').SmartWindowSnapshot[]
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
}) {
  if (activePositions.length === 0 && historyPositions.length === 0) {
    return (
      <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-8 text-center">
        <p className="text-[15px] text-cream-50">No DCA positions yet</p>
        <p className="mt-1 text-[12px] text-cream-35">Create one to start dollar cost averaging</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Active positions */}
      {activePositions.map(pos => {
        const snapshot = activeSnapshots.find(s => s.positionId === pos.config.id)
        return (
          <PositionCard
            key={pos.config.id}
            position={pos}
            snapshot={snapshot}
            onPause={() => { playClick(); onPause(pos.config.id) }}
            onResume={() => { playClick(); onResume(pos.config.id) }}
            onCancel={() => { playClick(); onCancel(pos.config.id) }}
          />
        )
      })}

      {/* History */}
      {historyPositions.length > 0 && (
        <>
          <div className="px-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-cream-35">
            History
          </div>
          {historyPositions.map(pos => (
            <PositionCard
              key={pos.config.id}
              position={pos}
              onPause={() => {}}
              onResume={() => {}}
              onCancel={() => {}}
            />
          ))}
        </>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
//  POSITION CARD
// ══════════════════════════════════════════════════════════

function PositionCard({
  position,
  snapshot,
  onPause,
  onResume,
  onCancel,
}: {
  position: import('@/lib/dca-types').DCAPosition
  snapshot?: import('@/lib/dca-types').SmartWindowSnapshot
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const { config, executions, status, totalExecuted } = position
  const progress = totalExecuted / config.numberOfParts
  const isActive = status === 'active'
  const isPaused = status === 'paused'

  // Next execution info
  const nextExec = executions.find(e =>
    e.status === 'scheduled' || e.status === 'window_open' || e.status === 'executing' || e.status === 'awaiting_sig'
  )
  const [countdown, setCountdown] = useState('')

  useEffect(() => {
    if (!nextExec || !isActive) return
    const timer = setInterval(() => {
      const target = nextExec.status === 'window_open' ? nextExec.windowCloseTime : nextExec.windowOpenTime
      const diff = Math.max(0, target - Date.now())
      const h = Math.floor(diff / 3600000)
      const m = Math.floor((diff % 3600000) / 60000)
      const s = Math.floor((diff % 60000) / 1000)
      setCountdown(h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`)
    }, 1000)
    return () => clearInterval(timer)
  }, [nextExec, isActive])

  const statusColor = {
    active: 'bg-success',
    paused: 'bg-warning',
    completed: 'bg-cream-50',
    cancelled: 'bg-danger',
  }[status]

  const statusLabel = {
    active: 'Active',
    paused: 'Paused',
    completed: 'Completed',
    cancelled: 'Cancelled',
  }[status]

  return (
    <div className="rounded-2xl border border-cream-08 bg-surface-secondary p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-cream">
            {config.tokenIn.symbol} → {config.tokenOut.symbol}
          </span>
          <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            isActive ? 'bg-success/15 text-success' : isPaused ? 'bg-warning/15 text-warning' : 'bg-cream-08 text-cream-35'
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
            {statusLabel}
          </span>
        </div>
        {(isActive || isPaused) && (
          <div className="flex gap-1">
            {isActive && (
              <button onClick={onPause} className="rounded-lg border border-cream-08 px-2 py-1 text-[10px] text-cream-50 hover:text-cream transition-colors">
                Pause
              </button>
            )}
            {isPaused && (
              <button onClick={onResume} className="rounded-lg border border-cream-08 px-2 py-1 text-[10px] text-cream-50 hover:text-cream transition-colors">
                Resume
              </button>
            )}
            <button onClick={onCancel} className="rounded-lg border border-danger/30 px-2 py-1 text-[10px] text-danger/70 hover:text-danger transition-colors">
              Cancel
            </button>
          </div>
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
        <span>{totalExecuted} of {config.numberOfParts} buys</span>
        <span>
          {formatUnits(BigInt(position.totalSpent || '0'), config.tokenIn.decimals)} {config.tokenIn.symbol} spent
        </span>
      </div>

      {/* Smart window status (if active) */}
      {snapshot && (
        <div className="rounded-xl border border-cream-gold/20 bg-cream-gold/5 p-3 mb-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="h-2 w-2 rounded-full bg-cream-gold animate-pulse" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-cream-gold">
              Smart Window Active
            </span>
          </div>
          <p className="text-[12px] text-cream-65 leading-relaxed">
            {snapshot.reason}
          </p>
          {snapshot.priceYesterday !== null && (
            <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <span className="text-cream-35">Yesterday</span>
                <div className="font-medium text-cream">${snapshot.priceYesterday?.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-cream-35">Window open</span>
                <div className="font-medium text-cream">${snapshot.priceAtWindowOpen?.toFixed(2)}</div>
              </div>
              <div>
                <span className="text-cream-35">Target</span>
                <div className="font-medium text-success">${snapshot.targetDipPrice?.toFixed(2)}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Next execution countdown */}
      {nextExec && isActive && !snapshot && (
        <div className="rounded-xl border border-cream-08 bg-surface-primary p-2.5 text-[12px]">
          <div className="flex justify-between">
            <span className="text-cream-35">
              {nextExec.status === 'window_open' ? 'Window closes in' : 'Next window opens in'}
            </span>
            <span className="font-semibold text-cream">{countdown}</span>
          </div>
        </div>
      )}

      {/* Recent executions (last 3) */}
      {executions.filter(e => e.status === 'executed' || e.status === 'failed').length > 0 && (
        <div className="mt-3 border-t border-cream-08 pt-3">
          <div className="text-[10px] font-medium uppercase tracking-wider text-cream-35 mb-2">
            Recent Buys
          </div>
          {executions
            .filter(e => e.status === 'executed' || e.status === 'failed')
            .slice(-3)
            .reverse()
            .map(exec => (
              <div key={exec.id} className="flex items-center justify-between py-1 text-[11px]">
                <span className="text-cream-50">Buy #{exec.index + 1}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  exec.status === 'executed' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
                }`}>
                  {exec.status === 'executed'
                    ? exec.executionReason === 'price_below_yesterday'
                      ? '↓ Price drop'
                      : exec.executionReason === 'dip_achieved'
                      ? '↓ 0.3% dip'
                      : '⏱ Window expired'
                    : '✗ Failed'
                  }
                </span>
                {exec.txHash && (
                  <a
                    href={`https://etherscan.io/tx/${exec.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cream-35 hover:text-cream-50"
                  >
                    ↗
                  </a>
                )}
              </div>
            ))
          }
        </div>
      )}
    </div>
  )
}
