'use client'

/**
 * CategoryChips — the TokenSelector category-filter row, made genuinely scrollable
 * for desktop MOUSE users (not only touch/trackpad). [chore/category-scroll-fix]
 *
 * ROOT CAUSE (verified in real Chromium @1280px — a JSDOM test "passed" but proved
 * nothing because JSDOM does no layout): the origin/main row already overflowed
 * (scrollWidth 846 > clientWidth 350) and was touch/trackpad-scrollable, but for a
 * desktop mouse it was both un-scrollable AND un-discoverable —
 *   • `no-scrollbar` hides the scrollbar               → nothing to grab/drag,
 *   • `tab-bar-fade` is `@media (max-width:639px)`     → no desktop affordance,
 *   • a vertical mouse wheel cannot scroll a horizontal container and there was no
 *     JS handler                                       → scrollLeft stayed 0 and the
 *                                                         last category was unreachable.
 * No ancestor clips the x-axis (the modal is portaled to <body>; the card is
 * overflow-visible) — so the fix is about INPUT + discoverability, not clipping.
 *
 * FIX (all mouse-usable on desktop, touch/trackpad unchanged):
 *   • bounded-width scroller (`w-full max-w-full`) with a `flex-nowrap` row of
 *     `shrink-0` chips that genuinely overflow it, `overflow-x-auto` on that element;
 *   • drag-to-scroll (pointer events) for mouse users — a click that ends a real
 *     drag is swallowed so dragging never toggles a filter;
 *   • vertical mouse wheel translated to horizontal scroll via a NATIVE non-passive
 *     listener (React's `onWheel` is passive, so `preventDefault` there is a no-op);
 *   • dynamic edge-fade affordances on EVERY viewport, toggled by scroll position,
 *     signalling there are more categories.
 * Filter behaviour (tap toggles; tap the active chip again clears) is unchanged.
 */
import { useRef, useState, useEffect, useCallback } from 'react'

interface Props {
  categories: string[]
  active: string | null
  onToggle: (cat: string) => void
}

export default function CategoryChips({ categories, active, onToggle }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  // Drag bookkeeping kept in a ref (no re-render per pointer move). `moved` gates the
  // click that ends a drag so a drag is never interpreted as a chip toggle.
  const drag = useRef({ active: false, startX: 0, startScroll: 0, moved: false })

  const updateFades = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setCanLeft(el.scrollLeft > 1)
    setCanRight(max > 1 && el.scrollLeft < max - 1)
  }, [])

  // Re-evaluate the fades on mount and whenever the category set changes.
  useEffect(() => {
    updateFades()
  }, [updateFades, categories])

  // Scroll INPUT handlers are all native: `wheel` must be non-passive so
  // preventDefault is honoured, and drag uses window-level move/up so a drag
  // continues outside the row without hijacking the chip `click` target (which
  // setPointerCapture would).
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return

    const onScroll = () => updateFades()

    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      // Only translate a predominantly-vertical wheel (classic mouse). Leave
      // horizontal trackpad gestures to the browser's native handling.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return // primary button only
      drag.current = { active: true, startX: e.clientX, startScroll: el.scrollLeft, moved: false }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!drag.current.active) return
      const dx = e.clientX - drag.current.startX
      if (Math.abs(dx) > 3) drag.current.moved = true
      el.scrollLeft = drag.current.startScroll - dx
    }
    const onPointerUp = () => {
      drag.current.active = false
    }

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
    <div className="relative mb-3">
      {/* Edge-fade affordances (every viewport) — purely visual; chips stay clickable
          beneath the transparent gradient. */}
      <div
        aria-hidden="true"
        data-testid="cat-fade-left"
        className={`pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-[#0F1318] to-transparent transition-opacity motion-reduce:transition-none ${canLeft ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        aria-hidden="true"
        data-testid="cat-fade-right"
        className={`pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-[#0F1318] to-transparent transition-opacity motion-reduce:transition-none ${canRight ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={scrollerRef}
        role="group"
        aria-label="Filter tokens by category"
        data-testid="category-chips"
        className="no-scrollbar flex w-full max-w-full cursor-grab flex-nowrap gap-1.5 overflow-x-auto overscroll-x-contain active:cursor-grabbing"
      >
        {categories.map((cat) => {
          const isActive = active === cat
          return (
            <button
              key={cat}
              type="button"
              aria-pressed={isActive}
              onClick={() => {
                // Swallow the click that terminates a drag → dragging never toggles.
                if (drag.current.moved) {
                  drag.current.moved = false
                  return
                }
                onToggle(cat)
              }}
              className={`inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 text-xs font-medium transition ${
                isActive
                  ? 'border-cream-gold text-cream'
                  : 'border-cream-08 bg-surface-tertiary text-cream-80 hover:border-cream-35 hover:bg-cream-05 hover:text-cream'
              }`}
            >
              {cat}
            </button>
          )
        })}
      </div>
    </div>
  )
}
