/**
 * [chore/mobile-ux-polish] Real-render harness entry for <ModeTabs/> — mounts the REAL component
 * (real scroll/drag/wheel/fade JS) inside the app's in-app column padding (px-3, the `swap-main`
 * context), so the bounded-width overflow it must handle at phone widths is reproduced exactly.
 * Bundled by build.mjs with the app's compiled Tailwind CSS and loaded via file:// — no dev server,
 * no env, deterministic in CI.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ModeTabs from '../../src/components/ModeTabs'

const TABS = [
  { mode: 'instant', label: 'Swap' },
  { mode: 'portfolio', label: 'Portfolio' },
  { mode: 'dca', label: 'DCA', comingSoon: true },
  { mode: 'orders', label: 'Orders' },
  { mode: 'history', label: 'History' },
  { mode: 'analytics', label: 'Analytics' },
]

function Harness() {
  const [active, setActive] = useState('instant')
  return (
    // Mirrors page.tsx's in-app main column padding (px-3) so the bar's max-w math is faithful.
    <main className="swap-main flex min-h-screen flex-col items-center px-3 pt-4 sm:px-4">
      <ModeTabs tabs={TABS} active={active} onSelect={setActive} />
      <div data-testid="active-mode">{active}</div>
      {/* Tall filler so the page scrolls — lets the sticky-pin assertion exercise real scroll. */}
      <div data-testid="tall-content" style={{ height: 2000 }} />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
