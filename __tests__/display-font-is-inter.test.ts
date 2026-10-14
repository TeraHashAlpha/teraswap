/**
 * [CHORE-NEXT-FONT-LOCAL] Headlines (`font-display`) render Inter, as production does today.
 * Clash Display is self-hosted but reserved for the visual redesign; flipping it is a deliberate visual change.
 */
import { describe, expect, it } from 'vitest'
import config from '../tailwind.config'

describe('tailwind display font family', () => {
  it('resolves to Inter, not Clash Display', () => {
    const display = (config.theme?.extend as { fontFamily: { display: string[] } }).fontFamily.display
    expect(display).toEqual(['var(--font-inter)', 'sans-serif'])
    expect(display.join(' ')).not.toMatch(/clash/i)
  })
})
