// @vitest-environment jsdom
/**
 * [ADR-025, feat/ui-v2-docs-legal] Content parity, Docs (the B10 gate): v1's DocsPage and v2's DocsTabV2 are
 * rendered against the SAME chain id; every visible v1 text node (normalised) must exist in v2, and every v1
 * `href` must still be linked. No allow-list: the "→" between FlowDiagram's steps is a plain separator in v2's
 * numbered list too (not a decorative glyph removal) — a bare "→" allow entry would strip that character from
 * EVERY v1 node globally, including the unrelated "USDC→USDT" inside the OpenOcean disabled-source message.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { compareContent } from '../__tests__/content-parity'

vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion: reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
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

const h = vi.hoisted(() => ({ chainId: 1 }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId }))

import DocsPage from '@/components/DocsPage'
import { DocsTabV2 } from './DocsTabV2'

afterEach(cleanup)
beforeAll(() => {
  h.chainId = 1
})

function renderBoth() {
  const v1 = render(<DocsPage />)
  const v2 = render(<DocsTabV2 />)
  return { v1: v1.container, v2: v2.container }
}

describe('Docs: v1 DocsPage ⊆ v2 DocsTabV2', () => {
  it('every visible v1 text node exists in v2 (no allow-list needed)', () => {
    const { v1, v2 } = renderBoth()
    const r = compareContent(v1, v2)
    expect(r.v1Nodes).toBeGreaterThan(200) // the walk really covers the whole 15-section page
    expect(r.missingText).toEqual([])
    expect(r.staleAllow).toEqual([])
  })

  it('every v1 href is still linked in v2', () => {
    const { v1, v2 } = renderBoth()
    const r = compareContent(v1, v2)
    expect(r.v1Hrefs).toBeGreaterThanOrEqual(2) // x.com, mailto
    expect(r.missingHrefs).toEqual([])
  })

  it('holds on another chain (chain-aware strings — feed count, chain name — move together)', () => {
    h.chainId = 8453
    const { v1, v2 } = renderBoth()
    const r = compareContent(v1, v2)
    expect(r.missingText).toEqual([])
    h.chainId = 1
  })
})
