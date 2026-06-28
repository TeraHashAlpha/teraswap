/**
 * Real-render harness entry. Mounts the REAL <CategoryChips/> inside a faithful copy
 * of the TokenSelector modal card (max-w-sm + p-4 + card background) so the
 * bounded-width overflow the component must handle is reproduced exactly.
 * [chore/category-scroll-fix]
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import CategoryChips from '../../src/components/CategoryChips'

// The realistic mainnet category set (CATEGORY_DISPLAY_ORDER, minus the
// empty/forward-compatible ones) — long labels that overflow a 384px card.
const CATEGORIES = [
  'Native', 'Stablecoin', 'Wrapped BTC', 'Liquid Staking', 'DeFi',
  'L2 & Infrastructure', 'AI & Data', 'Gaming & Metaverse', 'Memecoin', 'Gold',
]

function Harness() {
  const [active, setActive] = useState<string | null>(null)
  return (
    // Mirrors TokenSelector's modal card — the chip row's bounded ancestor.
    <div className="w-full max-w-sm rounded-2xl border border-cream-08 bg-[#0F1318] p-4">
      <CategoryChips
        categories={CATEGORIES}
        active={active}
        onToggle={(c) => setActive((prev) => (prev === c ? null : c))}
      />
      <div data-testid="active-category">{active ?? 'none'}</div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
