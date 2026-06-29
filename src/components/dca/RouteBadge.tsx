/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] RouteBadge — the aggregator the keeper routes each buy through,
 * derived from the order's committed router ("Velora" for Augustus V6 on Base). Gold brand pill.
 */
import { routeLabel } from '@/lib/order-engine/route-source'

export default function RouteBadge({ router, className = '' }: { router: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-cream-gold/30 bg-cream-gold/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cream-gold ${className}`}
      data-testid="route-badge"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></svg>
      {routeLabel(router)}
    </span>
  )
}
