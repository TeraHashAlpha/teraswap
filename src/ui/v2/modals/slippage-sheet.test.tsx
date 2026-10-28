// @vitest-environment jsdom
/**
 * [ADR-025] Frame 22 — the slippage sheet keeps v1's SlippageModal contract: presets, 0.01–15 clamp, the two notes, and the order of
 * the calls it makes. The parity case runs the same interactions against v1's modal so a drift shows up as a diff, not an opinion.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SlippageModalV1 from '@/components/SlippageModal'
import { SlippageSheet, SLIPPAGE_MAX, SLIPPAGE_MIN, SLIPPAGE_PRESETS } from './SlippageSheet'

afterEach(cleanup)

function setup(over: Partial<React.ComponentProps<typeof SlippageSheet>> = {}) {
  const calls: string[] = []
  const props = {
    value: 0.3,
    isAuto: true,
    tokenInSymbol: 'ETH',
    tokenOutSymbol: 'USDC',
    chainId: 1,
    onChange: vi.fn((v: number) => calls.push(`change:${v}`)),
    onAutoChange: vi.fn((a: boolean) => calls.push(`auto:${a}`)),
    onClose: vi.fn(() => calls.push('close')),
    ...over,
  }
  render(<SlippageSheet {...props} />)
  return { props, calls }
}

const custom = (v: string) => fireEvent.change(screen.getByLabelText('Custom slippage'), { target: { value: v } })
const ok = () => fireEvent.click(screen.getByRole('button', { name: 'OK' }))

describe('SlippageSheet (22)', () => {
  it('title, Auto row with the recommended value, the four presets, a custom field', () => {
    setup()
    expect(screen.getByRole('dialog', { name: 'Max slippage' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Auto/ }).textContent).toContain('0.3%')
    for (const p of SLIPPAGE_PRESETS) expect(screen.getByRole('button', { name: `${p}%` })).toBeTruthy()
    expect(SLIPPAGE_PRESETS).toEqual([0.1, 0.5, 1, 3])
    expect((screen.getByLabelText('Custom slippage') as HTMLInputElement).placeholder).toBe('Custom')
  })

  it('selected = cream + underline (aria-pressed): Auto when auto, the preset otherwise', () => {
    setup()
    expect(screen.getByRole('button', { name: /Auto/ }).getAttribute('aria-pressed')).toBe('true')
    cleanup()
    setup({ isAuto: false, value: 0.5 })
    expect(screen.getByRole('button', { name: /Auto/ }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '0.5%' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '1%' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('a preset: auto off, value, close — in that order (v1)', () => {
    const { calls } = setup()
    fireEvent.click(screen.getByRole('button', { name: '1%' }))
    expect(calls).toEqual(['auto:false', 'change:1', 'close'])
  })

  it("Auto: auto on, the pair's recommended value, close", () => {
    const { calls } = setup({ isAuto: false, value: 1, tokenInSymbol: 'PEPE', tokenOutSymbol: 'ETH' })
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }))
    expect(calls).toEqual(['auto:true', 'change:2', 'close']) // memecoin pair → 2 %
  })

  describe('custom bounds (0.01 – 15, v1 clamp)', () => {
    it.each([
      ['0.5', 0.5],
      ['0.01', 0.01],
      ['15', 15],
      ['0.001', 0.01], // below the floor → the floor
      ['50', 15], // above the ceiling → the ceiling
      ['-3', 0.01], // negative → the floor
      ['7.25', 7.25],
    ])('%s → %s', (typed, expected) => {
      const { calls } = setup()
      custom(typed)
      ok()
      expect(calls).toEqual(['auto:false', `change:${expected}`, 'close'])
    })

    it('the bounds are the ones on the field and in the module', () => {
      setup()
      const input = screen.getByLabelText('Custom slippage') as HTMLInputElement
      expect([input.min, input.max, input.step]).toEqual([String(SLIPPAGE_MIN), String(SLIPPAGE_MAX), '0.1'])
      expect([SLIPPAGE_MIN, SLIPPAGE_MAX]).toEqual([0.01, 15])
    })

    it('an empty field does nothing (v1 would set 0.01 %): OK is disabled and Enter is inert', () => {
      const { calls } = setup()
      expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true)
      fireEvent.keyDown(screen.getByLabelText('Custom slippage'), { key: 'Enter' })
      expect(calls).toEqual([])
    })

    it('Enter in the field applies it', () => {
      const { calls } = setup()
      custom('2')
      fireEvent.keyDown(screen.getByLabelText('Custom slippage'), { key: 'Enter' })
      expect(calls).toEqual(['auto:false', 'change:2', 'close'])
    })
  })

  describe('warnings (verbatim)', () => {
    it('manual value above 5 % → the loss warning; at 5 and in Auto → none', () => {
      setup({ isAuto: false, value: 5.5 })
      expect(screen.getByText('High slippage may result in significant losses.')).toBeTruthy()
      cleanup()
      setup({ isAuto: false, value: 5 })
      expect(screen.queryByText('High slippage may result in significant losses.')).toBeNull()
      cleanup()
      setup({ isAuto: true, value: 9 })
      expect(screen.queryByText('High slippage may result in significant losses.')).toBeNull()
    })

    it('Auto shows the volatility note and the pair recommendation; manual shows neither', () => {
      setup()
      expect(screen.getByText(/Auto-slippage adjusts based on token pair volatility\./)).toBeTruthy()
      expect(screen.getByText('ETH/USDC: 0.3% recommended')).toBeTruthy()
      cleanup()
      setup({ isAuto: false, value: 1 })
      expect(screen.queryByText(/Auto-slippage adjusts/)).toBeNull()
    })
  })

  it('parity with v1: same notes, same preset/custom calls for the same inputs', () => {
    const run = (Modal: React.ComponentType<React.ComponentProps<typeof SlippageModalV1>>, isAuto: boolean, value: number) => {
      const calls: string[] = []
      const { container } = render(
        <Modal
          value={value}
          isAuto={isAuto}
          tokenInSymbol="ETH"
          tokenOutSymbol="USDC"
          chainId={1}
          onChange={(v) => calls.push(`change:${v}`)}
          onAutoChange={(a) => calls.push(`auto:${a}`)}
          onClose={() => calls.push('close')}
        />,
      )
      const text = container.textContent ?? ''
      fireEvent.click(screen.getByText('1%'))
      const afterPreset = [...calls]
      calls.length = 0
      fireEvent.change(screen.getByPlaceholderText('Custom') as HTMLInputElement, { target: { value: '99' } })
      fireEvent.click(screen.getByText('OK'))
      const out = { text, afterPreset, custom: [...calls] }
      cleanup()
      return out
    }
    const norm = (s: string) => s.replace(/[⚙\s]+/g, ' ').trim()
    for (const [isAuto, value] of [[true, 0.3], [false, 6]] as const) {
      const a = run(SlippageModalV1, isAuto, value)
      const b = run(SlippageSheet, isAuto, value)
      // v2 adds only the chrome words of the sheet itself; every sentence v1 shows, v2 shows.
      for (const sentence of ['Max slippage', 'Auto-slippage adjusts based on token pair volatility.', 'ETH/USDC: 0.3% recommended', 'High slippage may result in significant losses.']) {
        expect(norm(b.text).includes(sentence)).toBe(norm(a.text).includes(sentence))
      }
      expect(b.afterPreset).toEqual(a.afterPreset)
      expect(b.custom).toEqual(a.custom)
    }
  })
})
