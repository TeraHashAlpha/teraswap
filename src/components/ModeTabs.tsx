'use client'

/**
 * [chore/mobile-ux-polish, chore/nav-tabs-no-clip] ModeTabs — the in-app mode navigation (Swap /
 * Portfolio / DCA / Orders / History / Analytics), extracted from page.tsx and made GENUINELY
 * scrollable at EVERY viewport width — no breakpoint switches to a force-shrink layout.
 *
 * ROOT CAUSE of the original mobile bug (verified in real Chromium @375px): the old inline tab bar
 * gave each button `flex-1`, so the tabs SHARED the capped container width and squished to ~54px /
 * ~38px-tall with 11px labels — `overflow-x-auto` never had anything to scroll, the static
 * `.tab-bar-fade` mask permanently dimmed the last tab, and there was no drag/wheel input. Tabs were
 * cramped, sub-44px, and the right-most ("Analytics") was visually clipped.
 *
 * [chore/nav-tabs-no-clip] The FIRST fix below re-introduced the SAME squeeze at `sm:` only
 * (`sm:flex-1` inside a fixed `sm:max-w-[540px]` container) — sized for the tab set at the time, it
 * clipped again ("Analytics" -> "Analy") the moment the label set grew wider than 540px worth of
 * equal shares. The fix now applies the SAME natural-width + scroll strategy at every breakpoint,
 * so there is no width threshold at which clipping can recur:
 *   • `shrink-0` + `whitespace-nowrap` tabs in a `flex-nowrap` row — every tab always renders at its
 *     full natural label width, at any viewport, never force-shrunk below it;
 *   • the outer container hugs that natural total width (`sm:w-fit`) instead of stretching/shrinking
 *     to a fixed pixel value, so desktop auto-widens to fit however many tabs are passed in;
 *   • if the tab set is ever wider than the viewport allows (mobile, or a future longer tab list),
 *     the row falls back to genuine horizontal scroll — same mechanism, same fades, same drag input,
 *     at every size, rather than two different behaviours per breakpoint;
 *   • each tab `min-h-[44px]` (≥44px tap target) and `text-[13px]` labels (≥12px readable);
 *   • drag-to-scroll (pointer) + vertical-wheel→horizontal (native non-passive) for mouse users;
 *   • dynamic edge-fades toggled by scroll position (replaces the misleading static mask);
 *   • the active tab auto-scrolls into view so a selected off-screen tab is never hidden.
 */

import { useRef, useState, useEffect, useCallback } from 'react'

export interface ModeTab {
  mode: string
  label: string
  comingSoon?: boolean
}

interface Props {
  tabs: ModeTab[]
  active: string
  onSelect: (mode: string) => void
}

export default function ModeTabs({ tabs, active, onSelect }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const drag = useRef({ active: false, startX: 0, startScroll: 0, moved: false })

  const updateFades = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setCanLeft(el.scrollLeft > 1)
    setCanRight(max > 1 && el.scrollLeft < max - 1)
  }, [])

  useEffect(() => { updateFades() }, [updateFades, tabs])

  // Keep the active tab visible (it may start off-screen on a narrow viewport).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const activeBtn = el.querySelector<HTMLElement>('[data-active="true"]')
    // Optional call: scrollIntoView is absent under jsdom (unit tests) — guard so it no-ops there.
    activeBtn?.scrollIntoView?.({ inline: 'center', block: 'nearest' })
  }, [active])

  // All scroll INPUT is native: `wheel` must be non-passive to honour preventDefault; drag uses
  // window-level move/up so a drag continues outside the row without hijacking the tab `click`.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => updateFades()
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault() }
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      drag.current = { active: true, startX: e.clientX, startScroll: el.scrollLeft, moved: false }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!drag.current.active) return
      const dx = e.clientX - drag.current.startX
      if (Math.abs(dx) > 3) drag.current.moved = true
      el.scrollLeft = drag.current.startScroll - dx
    }
    const onPointerUp = () => { drag.current.active = false }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('resize', updateFades)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('resize', updateFades)
    }
  }, [updateFades])

  return (
    <div className="sticky top-0 z-40 mb-4 w-full max-w-[calc(100vw-1.5rem)] sm:w-fit">
      {/* `relative` wrapper for the absolute edge-fades; the sticky lives on the OUTER element above
          so its containing block is the tall page column (the fades are out-of-flow and would zero
          out sticky travel if sticky sat here). */}
      <div className="relative w-full">
      <div
        aria-hidden="true"
        data-testid="mode-fade-left"
        className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-6 rounded-l-xl bg-gradient-to-r from-surface-secondary to-transparent transition-opacity motion-reduce:transition-none ${canLeft ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        aria-hidden="true"
        data-testid="mode-fade-right"
        className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-6 rounded-r-xl bg-gradient-to-l from-surface-secondary to-transparent transition-opacity motion-reduce:transition-none ${canRight ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={scrollerRef}
        aria-label="View"
        data-testid="mode-tabs"
        className="no-scrollbar flex w-full cursor-grab snap-x flex-nowrap gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-cream-08 bg-surface-secondary/95 p-1 backdrop-blur-md active:cursor-grabbing"
      >
        {tabs.map(({ mode, label, comingSoon }) => {
          const isActive = active === mode
          return (
            <button
              key={mode}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              data-active={isActive}
              disabled={comingSoon}
              aria-disabled={comingSoon}
              title={comingSoon ? 'Coming soon' : undefined}
              onClick={() => {
                if (drag.current.moved) { drag.current.moved = false; return }
                if (comingSoon) return
                onSelect(mode)
              }}
              className={`flex min-h-[44px] shrink-0 snap-start items-center justify-center whitespace-nowrap rounded-lg px-4 text-[13px] font-semibold transition-all ${
                comingSoon
                  ? 'cursor-not-allowed text-cream-35 opacity-50'
                  : isActive
                    ? 'bg-cream-gold text-[#080B10]'
                    : 'text-cream-50 hover:text-cream'
              }`}
            >
              {label}
              {comingSoon && (
                <span className="ml-1 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                  Soon
                </span>
              )}
            </button>
          )
        })}
      </div>
      </div>
    </div>
  )
}
