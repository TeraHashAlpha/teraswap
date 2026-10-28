// @vitest-environment jsdom
/**
 * [ADR-025] Frame 25 — the Permit2 explainer. v1's copy verbatim (parity run against v1's own modal), driven by the same
 * `useApproval` flags v1 uses, and "Don't show this again" is honoured by v1's own `isPermit2Educated()`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Permit2EducationModal, { isPermit2Educated } from '@/components/Permit2EducationModal'
import { compareContent } from '../__tests__/content-parity'
import { Permit2Sheet } from './Permit2Sheet'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('Permit2Sheet (25)', () => {
  it('parity: every visible v1 string and the learn-more link are in the v2 sheet (0 missing)', () => {
    const v1 = render(<Permit2EducationModal open onConfirm={() => {}} onCancel={() => {}} amount="1" tokenSymbol="ETH" />)
    const a = v1.container.cloneNode(true) as HTMLElement // detached snapshot of v1 (the modal is rendered in place, not portalled)
    cleanup()
    const v2 = render(<Permit2Sheet onConfirm={() => {}} onCancel={() => {}} amount="1" tokenSymbol="ETH" />)
    const glyph = (text: string) => ({ text, reason: 'decorative marker, aria-hidden in v2 (its line is read as "Legitimate…" / "Phishing…" / "If a site asks…")' })
    const result = compareContent(a, v2.container, [
      { text: '🔑', reason: 'decorative icon tile (round 7: no boxed icon); the heading carries the meaning' },
      glyph('✓'),
      glyph('✗'),
      glyph('!'),
    ])
    expect(result.missingText).toEqual([])
    expect(result.missingHrefs).toEqual([])
    expect(result.staleAllow).toEqual([])
  })

  it('the spender, the exact amount and the 24 h expiry are shown; with no amount the Amount row is not', () => {
    render(<Permit2Sheet onConfirm={() => {}} onCancel={() => {}} amount="0.5" tokenSymbol="ETH" />)
    expect(screen.getByRole('dialog', { name: 'About to sign a Permit2 approval' })).toBeTruthy()
    expect(screen.getByText('Permit2 (0x0000...30F1)')).toBeTruthy()
    expect(screen.getByText('0.5 ETH')).toBeTruthy()
    expect(screen.getByText('24 hours')).toBeTruthy()
    cleanup()
    render(<Permit2Sheet onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByText('Amount')).toBeNull()
  })

  it('Continue to signature is the ONE solid CTA; Cancel is a text button and takes focus (the safe default)', () => {
    render(<Permit2Sheet onConfirm={() => {}} onCancel={() => {}} />)
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1)
    expect(screen.getByRole('button', { name: 'Continue to signature' }).getAttribute('data-variant')).toBe('primary')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel.getAttribute('data-variant')).toBe('text')
    expect(document.activeElement).toBe(cancel)
  })

  it('Continue → confirm; Cancel and Esc → cancel; nothing is remembered unless the box is ticked', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<Permit2Sheet onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue to signature' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(isPermit2Educated()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it("“Don't show this again” sets v1's own flag (read back by v1's isPermit2Educated)", () => {
    const onConfirm = vi.fn()
    render(<Permit2Sheet onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByLabelText("Don't show this again"))
    fireEvent.click(screen.getByRole('button', { name: 'Continue to signature' }))
    expect(isPermit2Educated()).toBe(true)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keyboard: Tab stays inside the sheet (focus trap)', () => {
    render(<Permit2Sheet onConfirm={() => {}} onCancel={() => {}} />)
    const dlg = screen.getByRole('dialog')
    for (let i = 0; i < 8; i++) {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
      // jsdom does not move focus on Tab; the trap only intervenes at the edges, so walk to the last control and press Tab.
    }
    const links = dlg.querySelectorAll('a[href], button, input')
    ;(links[links.length - 1] as HTMLElement).focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(dlg.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(links[0])
  })
})
