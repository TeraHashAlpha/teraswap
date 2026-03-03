'use client'

/**
 * Skeleton — reusable loading placeholder with TeraSwap styling.
 * Uses a shimmer animation over cream-08 surface.
 */

interface SkeletonProps {
  className?: string
  /** Number of lines to render (default: 1) */
  lines?: number
  /** Show as a circle (e.g. for token icons) */
  circle?: boolean
}

export default function Skeleton({ className = '', lines = 1, circle }: SkeletonProps) {
  if (circle) {
    return (
      <div
        className={`animate-pulse rounded-full bg-cream-08 ${className}`}
      />
    )
  }

  if (lines > 1) {
    return (
      <div className={`space-y-2 ${className}`}>
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`h-3 animate-pulse rounded bg-cream-08 ${
              i === lines - 1 ? 'w-3/4' : 'w-full'
            }`}
          />
        ))}
      </div>
    )
  }

  return (
    <div className={`animate-pulse rounded bg-cream-08 ${className}`} />
  )
}

/** Skeleton for the full SwapBox layout — shown while wallet/chain is loading */
export function SwapBoxSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[calc(100vw-2rem)] rounded-2xl border border-cream-08 bg-surface-secondary/85 px-3 py-4 shadow-xl shadow-black/20 backdrop-blur-lg sm:max-w-[460px] sm:p-5">
      {/* Sell label */}
      <div className="mb-1">
        <Skeleton className="mb-2 h-3 w-8" />
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-tertiary p-3">
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </div>

      {/* Invert button */}
      <div className="relative z-10 -my-2 flex justify-center">
        <Skeleton circle className="h-9 w-9" />
      </div>

      {/* Receive label */}
      <div className="mb-4 mt-1">
        <Skeleton className="mb-2 h-3 w-12" />
        <div className="flex items-center gap-2 rounded-xl border border-cream-08 bg-surface-tertiary p-3">
          <Skeleton className="h-8 flex-1" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      </div>

      {/* Button */}
      <Skeleton className="h-12 w-full rounded-xl" />
    </div>
  )
}

/** Skeleton for QuoteBreakdown */
export function QuoteBreakdownSkeleton() {
  return (
    <div className="rounded-xl border border-cream-08 bg-surface-tertiary p-3">
      <div className="mb-3 flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-8" />
      </div>
      <Skeleton lines={4} className="mb-2" />
      <div className="my-2 border-t border-cream-08" />
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-28" />
      </div>
    </div>
  )
}
