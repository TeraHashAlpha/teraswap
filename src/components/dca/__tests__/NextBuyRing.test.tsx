// @vitest-environment jsdom
/**
 * [CHORE-DCA-POSITIONS-DASHBOARD] NextBuyRing — the SVG progress ring (N of M) that frames the
 * countdown. Geometry: the arc's strokeDashoffset encodes (1 - progress) of the full circumference.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import NextBuyRing from '../NextBuyRing'

function arcOffsetRatio() {
  const arc = screen.getByTestId('ring-arc')
  const dash = parseFloat(arc.getAttribute('stroke-dasharray') || '0')
  const offset = parseFloat((arc as unknown as SVGCircleElement).style.strokeDashoffset || arc.getAttribute('stroke-dashoffset') || '0')
  return offset / dash
}

describe('NextBuyRing geometry', () => {
  it('empty progress → arc fully hidden (offset == circumference)', () => {
    render(<NextBuyRing progress={0} />)
    expect(arcOffsetRatio()).toBeCloseTo(1, 3)
  })
  it('full progress → arc fully drawn (offset ~ 0)', () => {
    render(<NextBuyRing progress={1} />)
    expect(arcOffsetRatio()).toBeCloseTo(0, 3)
  })
  it('half progress → half the circumference', () => {
    render(<NextBuyRing progress={0.5} />)
    expect(arcOffsetRatio()).toBeCloseTo(0.5, 3)
  })
  it('clamps out-of-range progress', () => {
    render(<NextBuyRing progress={2} />)
    expect(arcOffsetRatio()).toBeCloseTo(0, 3)
  })
})

describe('NextBuyRing accent', () => {
  it('gold accent (normal)', () => {
    render(<NextBuyRing progress={0.3} accent="gold" />)
    expect(screen.getByTestId('ring-arc').getAttribute('stroke')).toBe('#C8B89A')
  })
  it('success accent (under 60s / completed)', () => {
    render(<NextBuyRing progress={0.3} accent="success" />)
    expect(screen.getByTestId('ring-arc').getAttribute('stroke')).toBe('#4ADE80')
  })
  it('renders centered children', () => {
    render(<NextBuyRing progress={0.3}><span>02:00:00</span></NextBuyRing>)
    expect(screen.getByText('02:00:00')).toBeInTheDocument()
  })
})

describe('NextBuyRing orbit dot rides the arc head', () => {
  it('places the dot at the same parametric angle as the arc head (θ = p·2π, SVG-local)', () => {
    // size=220, stroke=10 → r=105, center=110. At p=0.25 the arc head is at local angle π/2
    // (cos=0, sin=1) → cx≈center, cy≈center+r. (A -π/2 offset would wrongly put it at 3 o'clock.)
    render(<NextBuyRing progress={0.25} size={220} stroke={10} />)
    const dot = screen.getByTestId('ring-dot')
    expect(parseFloat(dot.getAttribute('cx')!)).toBeCloseTo(110, 1)
    expect(parseFloat(dot.getAttribute('cy')!)).toBeCloseTo(215, 1)
  })
})
