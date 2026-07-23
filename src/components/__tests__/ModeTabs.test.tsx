// @vitest-environment jsdom
/**
 * [chore/nav-tabs-no-clip] ModeTabs — no label clipping at any width, active-tab styling and "Soon"
 * badges preserved, routing/gating untouched.
 *
 * jsdom performs no real CSS layout, so "no clipping at a given viewport" is asserted two ways:
 *   1. class-based — the exact CSS mechanism that caused the regression (`flex-1` force-shrinking a
 *      tab below its label's natural width inside a FIXED-width container) must be absent, at every
 *      breakpoint prefix, and no truncate/ellipsis/overflow-hidden class ever sits on a label; and
 *   2. content-based — every label's FULL text renders (e.g. "Analytics", never a truncated "Analy"),
 *      proving no JS-side string truncation either.
 * Together these pin BOTH the CSS root cause and the visible symptom, independent of an actual
 * browser layout pass.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModeTabs, { type ModeTab } from '../ModeTabs'

const TABS: ModeTab[] = [
  { mode: 'instant', label: 'Swap' },
  { mode: 'portfolio', label: 'Portfolio' },
  { mode: 'dca', label: 'DCA' },
  { mode: 'limit', label: 'Limit', comingSoon: true },
  { mode: 'sltp', label: 'SL/TP', comingSoon: true },
  { mode: 'orders', label: 'Orders' },
  { mode: 'history', label: 'History' },
  { mode: 'analytics', label: 'Analytics' },
]

function renderTabs(overrides: Partial<{ active: string; onSelect: (mode: string) => void }> = {}) {
  const onSelect = overrides.onSelect ?? vi.fn()
  const utils = render(<ModeTabs tabs={TABS} active={overrides.active ?? 'instant'} onSelect={onSelect} />)
  return { ...utils, onSelect }
}

describe('ModeTabs — no clipping (regression: "Analytics" rendered as "Analy")', () => {
  it('renders every tab label FULL and unabbreviated, never a truncated substring', () => {
    renderTabs()
    for (const tab of TABS) {
      const btn = screen.getByRole('button', { name: new RegExp(`^${tab.label}`) })
      // The exact bug symptom: textContent must contain the WHOLE label, not a prefix like "Analy".
      expect(btn.textContent).toContain(tab.label)
    }
    // Specifically pin the reported symptom for the rightmost tab.
    expect(screen.getByRole('button', { name: /^Analytics/ }).textContent).toContain('Analytics')
    expect(screen.getByRole('button', { name: /^Analytics/ }).textContent).not.toBe('Analy')
  })

  it('no tab button carries a truncate/ellipsis/overflow-hidden class at ANY breakpoint prefix', () => {
    renderTabs()
    const buttons = screen.getAllByRole('button')
    const clippingClassPattern = /(^|:)(truncate|overflow-hidden|text-ellipsis|line-clamp)/
    for (const btn of buttons) {
      const classes = btn.className.split(/\s+/)
      expect(classes.some((c) => clippingClassPattern.test(c))).toBe(false)
    }
  })

  it('no tab button uses flex-1 at any breakpoint — the exact class that caused the desktop clip regression', () => {
    renderTabs()
    for (const btn of screen.getAllByRole('button')) {
      const classes = btn.className.split(/\s+/)
      expect(classes).not.toEqual(expect.arrayContaining(['flex-1']))
      expect(classes.some((c) => /^(sm|md|lg|xl|2xl):flex-1$/.test(c))).toBe(false)
    }
  })

  it('every tab keeps shrink-0 + whitespace-nowrap (natural width at every size, never force-shrunk)', () => {
    renderTabs()
    for (const btn of screen.getAllByRole('button')) {
      expect(btn.className).toContain('shrink-0')
      expect(btn.className).toContain('whitespace-nowrap')
    }
  })

  it('the outer container hugs content width on wider viewports (sm:w-fit) instead of a fixed pixel cap that forced the squeeze', () => {
    const { container } = renderTabs()
    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain('sm:w-fit')
    expect(outer.className).not.toMatch(/sm:max-w-\[/)
  })

  it('the row still has a genuine horizontal-scroll fallback (overflow-x-auto) for whenever content exceeds the viewport, at any width', () => {
    renderTabs()
    const scroller = screen.getByTestId('mode-tabs')
    expect(scroller.className).toContain('overflow-x-auto')
    expect(scroller.className).toContain('flex-nowrap')
  })
})

describe('ModeTabs — active styling + Soon badges preserved', () => {
  it('marks the active tab via aria-current + data-active, and gives it the gold treatment', () => {
    renderTabs({ active: 'dca' })
    const activeBtn = screen.getByRole('button', { name: /^DCA/ })
    expect(activeBtn).toHaveAttribute('aria-current', 'page')
    expect(activeBtn).toHaveAttribute('data-active', 'true')
    expect(activeBtn.className).toContain('bg-cream-gold')
  })

  it('renders a "Soon" badge on coming-soon tabs and disables them', () => {
    renderTabs()
    const limitBtn = screen.getByRole('button', { name: /^Limit/ })
    expect(limitBtn.textContent).toContain('Soon')
    expect(limitBtn).toBeDisabled()
    expect(limitBtn).toHaveAttribute('aria-disabled', 'true')
  })

  it('does not render a Soon badge on a live tab', () => {
    renderTabs()
    const swapBtn = screen.getByRole('button', { name: /^Swap/ })
    expect(swapBtn.textContent).not.toContain('Soon')
    expect(swapBtn).not.toBeDisabled()
  })
})

describe('ModeTabs — routing/gating untouched', () => {
  it('calls onSelect with the tab mode when a live tab is clicked', () => {
    const { onSelect } = renderTabs()
    fireEvent.click(screen.getByRole('button', { name: /^History/ }))
    expect(onSelect).toHaveBeenCalledWith('history')
  })

  it('never calls onSelect for a coming-soon tab', () => {
    const { onSelect } = renderTabs()
    fireEvent.click(screen.getByRole('button', { name: /^SL\/TP/ }))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
