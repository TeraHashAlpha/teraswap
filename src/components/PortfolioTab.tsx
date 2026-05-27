'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount } from 'wagmi'
import { CATEGORY_DISPLAY_ORDER, type Token, type TokenCategory } from '@/lib/tokens'
import { usePortfolio, type PortfolioToken } from '@/hooks/usePortfolio'

interface PortfolioTabProps {
  onSwapToken?: (token: Token) => void
}

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function formatLastUpdated(date: Date | null, now: number): string {
  if (!date) return ''
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function categoryIndex(cat: TokenCategory): number {
  const idx = CATEGORY_DISPLAY_ORDER.indexOf(cat)
  return idx === -1 ? CATEGORY_DISPLAY_ORDER.length : idx
}

// Initials avatar shown when a token logo fails to load. Cream-gold disc
// with the symbol's first letter — same palette as the rest of the app.
function TokenAvatar({ token }: { token: Token }) {
  const [errored, setErrored] = useState(false)
  if (errored || !token.logoURI) {
    return (
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cream-gold text-[11px] font-bold text-[#080B10]"
        aria-hidden
      >
        {token.symbol.charAt(0).toUpperCase()}
      </div>
    )
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={token.logoURI}
      alt={`${token.symbol} logo`}
      width={32}
      height={32}
      className="h-8 w-8 shrink-0 rounded-full bg-surface object-cover"
      onError={() => setErrored(true)}
    />
  )
}

function PortfolioRow({
  entry,
  onSwapToken,
}: {
  entry: PortfolioToken
  onSwapToken?: (token: Token) => void
}) {
  const { token, balanceFormatted, valueUsd } = entry
  return (
    <div className="flex items-center justify-between rounded-xl border border-cream-08 bg-surface-tertiary px-3 py-2.5 transition hover:border-cream-15">
      <div className="flex min-w-0 items-center gap-3">
        <TokenAvatar token={token} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-cream">{token.symbol}</div>
          <div className="truncate text-[11px] text-cream-50">{token.name}</div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="text-sm font-semibold text-cream tabular-nums">{balanceFormatted}</div>
          <div className="text-[11px] text-cream-50 tabular-nums">
            {valueUsd !== null ? usdFormatter.format(valueUsd) : '—'}
          </div>
        </div>
        {onSwapToken && (
          <button
            onClick={() => onSwapToken(token)}
            className="rounded-lg border border-cream-08 px-2.5 py-1 text-[11px] font-medium text-cream-50 transition hover:border-cream-35 hover:text-cream"
            aria-label={`Swap ${token.symbol}`}
          >
            Swap
          </button>
        )}
      </div>
    </div>
  )
}

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? 'animate-spin' : ''}
      aria-hidden="true"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  )
}

export default function PortfolioTab({ onSwapToken }: PortfolioTabProps) {
  const { isConnected } = useAccount()
  const { tokens, totalValueUsd, isLoading, isError, lastUpdated, refresh } = usePortfolio()

  // Tick once per second so the "X seconds ago" string updates without
  // depending on lastUpdated identity. Pauses when there's no timestamp.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    if (!lastUpdated) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [lastUpdated])

  // Group sorted tokens by category, preserving USD-value order inside
  // each group. The outer order follows CATEGORY_DISPLAY_ORDER so the
  // visual layout is stable across refreshes.
  const grouped = useMemo(() => {
    const buckets = new Map<TokenCategory, PortfolioToken[]>()
    for (const entry of tokens) {
      const list = buckets.get(entry.token.category) ?? []
      list.push(entry)
      buckets.set(entry.token.category, list)
    }
    return Array.from(buckets.entries()).sort(
      ([a], [b]) => categoryIndex(a) - categoryIndex(b),
    )
  }, [tokens])

  if (!isConnected) {
    return (
      <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
        <p className="text-sm text-cream-35">Connect your wallet to view your portfolio</p>
      </div>
    )
  }

  return (
    <div className="w-full space-y-3">
      {/* Header */}
      <div className="rounded-xl border border-cream-08 bg-surface-secondary px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-cream-50">
              Total value
            </div>
            <div className="mt-1 text-2xl font-bold text-cream tabular-nums">
              {totalValueUsd !== null ? usdFormatter.format(totalValueUsd) : '—'}
            </div>
            <div className="mt-1 text-[11px] text-cream-50">
              {lastUpdated ? `Last updated ${formatLastUpdated(lastUpdated, now)}` : 'Loading prices…'}
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={isLoading}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cream-08 text-cream-50 transition hover:border-cream-35 hover:text-cream disabled:opacity-50"
            aria-label="Refresh portfolio"
          >
            <RefreshIcon spinning={isLoading} />
          </button>
        </div>
      </div>

      {/* Error */}
      {isError && (
        <div className="flex items-center justify-between rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          <span>Failed to load portfolio.</span>
          <button
            onClick={refresh}
            className="rounded border border-danger/40 px-2 py-0.5 text-[11px] font-semibold text-danger transition hover:bg-danger/20"
          >
            Try again
          </button>
        </div>
      )}

      {/* Loading skeleton (initial fetch, no rows yet) */}
      {isLoading && tokens.length === 0 && !isError && (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-[60px] animate-pulse rounded-xl bg-surface-tertiary"
            />
          ))}
        </div>
      )}

      {/* Empty (connected, no balances, not loading) */}
      {!isLoading && !isError && tokens.length === 0 && (
        <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-6 text-center">
          <p className="text-sm text-cream-35">No tokens found in this wallet on Ethereum mainnet.</p>
        </div>
      )}

      {/* Token list — grouped by category */}
      {tokens.length > 0 && (
        <div className="space-y-4">
          {grouped.map(([category, entries]) => (
            <div key={category} className="space-y-1.5">
              <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-cream-35">
                {category}
              </div>
              {entries.map((entry) => (
                <PortfolioRow
                  key={entry.token.address}
                  entry={entry}
                  onSwapToken={onSwapToken}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
