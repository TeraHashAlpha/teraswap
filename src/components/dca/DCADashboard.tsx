'use client'

/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] DCADashboard — the Positions tab body. Active orders get the rich,
 * live MissionControlCard (countdown ring centerpiece); history keeps the compact DCAOrderCard. Cancel
 * All / Remove All gating and the empty-state copy are preserved; an empty state adds a Create CTA.
 * Cards mount with a gentle stagger (reduced-motion safe via CSS).
 */

import type { AutonomousOrder, OrderEngineEvent } from '@/lib/order-engine'
import { playClick } from '@/lib/sounds'
import MissionControlCard from './MissionControlCard'
import DCAOrderCard from './DCAOrderCard'

interface Props {
  active: AutonomousOrder[]
  history: AutonomousOrder[]
  latestEvent?: OrderEngineEvent | null
  onCancel: (id: string) => void
  onCancelAll: () => Promise<void> | void
  onRemove: (id: string) => void
  /** Switch the panel to the create form (empty-state CTA). */
  onCreate?: () => void
}

export default function DCADashboard({ active, history, latestEvent, onCancel, onCancelAll, onRemove, onCreate }: Props) {
  if (active.length === 0 && history.length === 0) {
    return (
      <div className="relative overflow-hidden rounded-2xl border border-cream-08 bg-surface-secondary p-8 text-center">
        <div aria-hidden="true" className="pointer-events-none absolute left-1/2 top-0 h-40 w-40 -translate-x-1/2 rounded-full bg-cream-gold/10 blur-[80px]" />
        <p className="relative text-[15px] text-cream-50">No DCA positions yet</p>
        <p className="relative mt-1 text-[12px] text-cream-35">Create one to start autonomous dollar cost averaging</p>
        {onCreate && (
          <button
            onClick={() => { playClick(); onCreate() }}
            className="relative mt-4 rounded-xl bg-gradient-to-r from-gold to-gold-light px-5 py-2.5 text-[13px] font-bold uppercase tracking-wider text-[#080B10] transition-all hover:brightness-110 active:scale-[0.98]"
          >
            Start a DCA
          </button>
        )}
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
          {active.map((order, i) => (
            <div key={order.id} className="motion-safe:animate-fade-slide-in" style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}>
              <MissionControlCard
                order={order}
                latestEvent={latestEvent}
                onCancel={() => { playClick(); onCancel(order.id) }}
              />
            </div>
          ))}
        </>
      )}

      {history.length > 0 && (
        <>
          <div className="flex items-center justify-between px-1 pt-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-cream-35">History</span>
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
