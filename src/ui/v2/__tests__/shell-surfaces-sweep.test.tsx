// @vitest-environment jsdom
/**
 * [L-1, A75] The whole-app parity sweep (parity-sweep.test.tsx) renders v1's SwapBox alone against v2's SwapCard
 * alone — it never catches a v1 SIBLING of the embedded widget (page.tsx renders SwapHistory and the Share button
 * next to SwapBox, not inside it), so "Recent swaps" and Share were missing from v2 with 0 sweep failures. This file
 * is that missing coverage: it compares the SIBLING surfaces directly, and pins that the two surfaces the owner
 * ruled NOT to build (theme toggle, landing dot-nav — neither has visible text a sweep could catch; see the
 * content-map) are recorded, so a reviewer finds a ruling instead of silence.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { compareContent, type AllowedRemoval } from './content-parity'
import { useSwapHistory, type SwapRecord } from '@/hooks/useSwapHistory'
import SwapHistory from '@/components/SwapHistory'
import { RecentSwaps } from '../swap/RecentSwaps'

// v1 prints the expand arrow and the status glyph as plain text; v2 draws them `aria-hidden` beside the accessible
// "Recent swaps (N)" button and the "Explorer" link (round 7's own rule for every other decorative glyph — see the
// content-map / parity-sweep.test.tsx's `GLYPH` reason).
const GLYPH = 'decorative glyph, aria-hidden in v2; the control/link keeps its accessible name'
const ALLOW: AllowedRemoval[] = [['▲', GLYPH], ['▼', GLYPH], ['✓', GLYPH], ['✗', GLYPH], ['⏳', GLYPH]].map(([text, reason]) => ({ text, reason }))

const RECORDS: SwapRecord[] = [
  { id: 'r1', date: '2026-11-05', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '1', amountOut: '2487.6842', txHash: '0xabc', status: 'confirmed', chainId: 1 },
  { id: 'r2', date: '2026-11-04', tokenIn: 'USDC', tokenOut: 'ETH', amountIn: '100', amountOut: '0.04', txHash: '0xdef', status: 'failed', chainId: 8453 },
]

afterEach(() => {
  cleanup()
  useSwapHistory.setState({ records: [] })
})

describe('sweep · Swap · shell surfaces (v1 page.tsx siblings of SwapBox, not just the card itself)', () => {
  it('Recent swaps: v1 (collapsed) text ⊆ v2, 0 missing', () => {
    useSwapHistory.setState({ records: RECORDS })
    const v1 = render(<SwapHistory />)
    const v2 = render(<RecentSwaps />)
    const r = compareContent(v1.container, v2.container, ALLOW)
    expect(r.missingText).toEqual([])
  })

  it('Recent swaps: expanded, v1 row text (amounts, status, Explorer links) ⊆ v2, 0 missing', () => {
    useSwapHistory.setState({ records: RECORDS })
    const v1 = render(<SwapHistory />)
    fireEvent.click(within(v1.container).getByText('Recent swaps (2)'))
    const v2 = render(<RecentSwaps />)
    fireEvent.click(within(v2.container).getByText('Recent swaps (2)'))
    const r = compareContent(v1.container, v2.container, ALLOW)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
  })
})

describe('shell surfaces ruled NOT to build (theme toggle, landing dot-nav) and the v1 typo v2 does not copy: recorded, not silently dropped', () => {
  const contentMap = readFileSync(join(process.cwd(), 'docs/feedback/feat-ui-v2-mobile-parity.md'), 'utf8')

  it.each([
    ['Theme toggle', /\|\s*Theme toggle\s*\|.*NOT built/],
    ['landing dot-nav', /\|\s*Desktop dot-nav.*\|.*NOT built/],
    // [A75b] v1 prints `Share — saved 0.27%%` (SwapBox.tsx: fmtPct() already ends in %, the label template adds another).
    // v2 keeps ONE % and does not copy the typo; the content-map names it a v1 typo.
    ['Share label %', /\|\s*Share label `%%`.*\|.*v1 typo.*\|/],
  ])('%s has a ruled delta row in the content-map', (_label, pattern) => {
    expect(contentMap).toMatch(pattern)
  })
})
