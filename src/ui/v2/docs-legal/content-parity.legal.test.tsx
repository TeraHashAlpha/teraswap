// @vitest-environment jsdom
/**
 * [ADR-025, feat/ui-v2-docs-legal] Content parity, Terms/Privacy (the B10 gate): v1's LegalPage and the v2
 * LegalPageV2 are rendered side by side; every visible v1 text node (normalised) must exist in v2, and every
 * v1 `href` must still be linked. The ONLY allowed removal is the owner-approved "100% secure" → "no system is
 * completely secure" sentence (identical edit lands in both — see LegalPage.tsx:131 and LegalPageV2.tsx).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { compareContent, type AllowedRemoval } from '../__tests__/content-parity'

beforeAll(() => {
  window.scrollTo = (() => {}) as typeof window.scrollTo
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
})

import LegalPage from '@/components/LegalPage'
import { LegalPageV2 } from './LegalPageV2'

const ALLOW: readonly AllowedRemoval[] = []

afterEach(cleanup)

describe.each(['privacy', 'terms'] as const)('Legal: v1 LegalPage(type=%s) ⊆ v2 LegalPageV2', (type) => {
  it('every visible v1 text node exists in v2, after the one owner-approved copy change', () => {
    const v1 = render(<LegalPage type={type} />)
    const v2 = render(<LegalPageV2 type={type} />)
    const r = compareContent(v1.container, v2.container, ALLOW)
    expect(r.v1Nodes).toBeGreaterThan(30) // the fixture really renders the full section text, not an empty shell
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
  })

  it('both say "no system is completely secure" and neither still says "100% secure"', () => {
    if (type !== 'privacy') return
    const v1 = render(<LegalPage type={type} />)
    const v2 = render(<LegalPageV2 type={type} />)
    for (const c of [v1.container, v2.container]) {
      expect(c.textContent).toContain('no system is completely secure')
      expect(c.textContent).not.toMatch(/100% secure/)
    }
  })
})
