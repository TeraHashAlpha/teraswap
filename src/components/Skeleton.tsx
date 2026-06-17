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
