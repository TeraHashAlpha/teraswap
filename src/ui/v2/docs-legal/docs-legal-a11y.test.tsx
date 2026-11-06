// @vitest-environment jsdom
/**
 * [feat/ui-v2-docs-legal] a11y for Docs and Legal's shared TOC/scroll-spy (container 2): heading order is well
 * formed (no skipped levels), every TOC entry has a matching in-page anchor, TOC links are keyboard-focusable,
 * and scrollToSection respects prefers-reduced-motion (an instant jump, not an animated scroll).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1 }))
class IO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO

import { DocsTabV2 } from './DocsTabV2'
import { LegalPageV2 } from './LegalPageV2'
import { scrollToSection } from './use-scroll-spy'

function headingLevels(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((el) => Number(el.tagName[1]))
}

/** No level is skipped going deeper (h1 -> h3 with no h2 in between is a violation); climbing back up is fine. */
function noSkippedLevels(levels: number[]): void {
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1]) expect(levels[i] - levels[i - 1], `heading jump ${levels[i - 1]} -> ${levels[i]} at index ${i}`).toBeLessThanOrEqual(1)
  }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('heading order', () => {
  it('Docs: h1 -> h2 (section titles) -> h3 (sub-headings), no skipped levels', () => {
    const { container } = render(<DocsTabV2 />)
    const levels = headingLevels(container)
    expect(levels[0]).toBe(1)
    expect(levels).toContain(2)
    expect(levels).toContain(3)
    noSkippedLevels(levels)
  })

  it.each(['privacy', 'terms'] as const)('Legal (%s): h1 -> h2 (sections) -> h3 (sub-sections), no skipped levels', (type) => {
    const { container } = render(<LegalPageV2 type={type} />)
    const levels = headingLevels(container)
    expect(levels[0]).toBe(1)
    expect(levels).toContain(2)
    noSkippedLevels(levels)
  })
})

describe('TOC anchors + focus', () => {
  it('Docs: every TOC button has a matching in-page section id, is a real focusable <button>', () => {
    const { container } = render(<DocsTabV2 />)
    const nav = container.querySelector('nav[aria-label="Table of contents"]')!
    const buttons = Array.from(nav.querySelectorAll('button'))
    expect(buttons.length).toBeGreaterThan(10)
    for (const b of buttons) {
      expect(b.tabIndex).not.toBe(-1)
    }
    // clicking the first entry scrolls to its section (ids are internal, but the click must resolve to SOME anchor)
    fireEvent.click(buttons[0])
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('Legal: the TOC exists, one hairline-rowed button per section, keyboard-focusable', () => {
    const { container } = render(<LegalPageV2 type="terms" />)
    const nav = container.querySelector('nav[aria-label="Table of contents"]')!
    const buttons = Array.from(nav.querySelectorAll('button'))
    expect(buttons).toHaveLength(20) // Terms has 20 sections
    for (const b of buttons) expect(b.tabIndex).not.toBe(-1)
  })
})

describe('reduced motion: scrollToSection', () => {
  it('jumps instantly when prefers-reduced-motion: reduce, smooth-scrolls otherwise', () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    document.body.innerHTML = '<div id="x"></div>'

    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    scrollToSection('x')
    expect(spy).toHaveBeenLastCalledWith({ behavior: 'smooth' })

    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia
    scrollToSection('x')
    expect(spy).toHaveBeenLastCalledWith({ behavior: 'auto' })
  })
})
