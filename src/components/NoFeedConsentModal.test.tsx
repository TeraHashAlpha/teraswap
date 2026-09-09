// @vitest-environment jsdom
/**
 * [FIX-DCA-NOFEED-CONSENT] NoFeedConsentModal — unit tests for the standalone component
 * (focus/Esc/Accept-Reject wiring).
 *
 * [FIX-DCA-NOFEED-FAIL-CLOSED] The component is deprecated — no flow routes to it — but it is
 * retained (rule #4), so its tests are too. The plain-language COPY tests moved here from
 * DCAPanel.nofeed-consent.test.tsx, which can no longer reach the modal through the panel; they
 * render the component directly and are unchanged in substance, plus one new assertion pinning the
 * removal of the false protection claim.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import NoFeedConsentModal from './NoFeedConsentModal'

describe('NoFeedConsentModal', () => {
  it('renders nothing when closed', () => {
    render(<NoFeedConsentModal open={false} tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={vi.fn()} />)
    expect(screen.queryByTestId('nofeed-consent-modal')).not.toBeInTheDocument()
  })

  it('Accept calls onAccept exactly once', () => {
    const onAccept = vi.fn()
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={onAccept} onReject={vi.fn()} />)
    fireEvent.click(screen.getByTestId('nofeed-consent-accept'))
    expect(onAccept).toHaveBeenCalledTimes(1)
  })

  it('Reject calls onReject exactly once', () => {
    const onReject = vi.fn()
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={onReject} />)
    fireEvent.click(screen.getByTestId('nofeed-consent-reject'))
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('Reject is the default focus target (safe default)', () => {
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={vi.fn()} />)
    expect(document.activeElement).toBe(screen.getByTestId('nofeed-consent-reject'))
  })

  it('Escape triggers onReject', () => {
    const onReject = vi.fn()
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={onReject} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onReject).toHaveBeenCalledTimes(1)
  })

  it('the copy makes no protection claim the code does not deliver', () => {
    // The sentence this component was corrected for: "Your buys still only happen at the lowest
    // amount you agree to each time, so you're not unprotected". With no feed registered in the
    // executor that floor is the ADR-013 dust fallback, so the reassurance was false.
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={vi.fn()} />)
    const body = screen.getByTestId('nofeed-consent-body').textContent ?? ''
    expect(body).not.toMatch(/not unprotected/i)
    expect(body).not.toMatch(/you are protected/i)
    // …and it says plainly that the backstop is not a fair-price check.
    expect(body).toMatch(/not a fair-price check/i)
  })

  it('clicking the backdrop triggers onReject (never onAccept)', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={onAccept} onReject={onReject} />)
    fireEvent.click(screen.getByRole('presentation'))
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onAccept).not.toHaveBeenCalled()
  })
})

// ── Relocated from DCAPanel.nofeed-consent.test.tsx (the panel no longer renders this modal) ──

describe('NoFeedConsentModal [FIX-DCA-NOFEED-CONSENT] — plain-language copy, zero jargon', () => {
  const JARGON_DENYLIST = [/\boracle\b/i, /\bfeed\b/i, /\bslippage\b/i, /\bminamountout\b/i, /\bminimumoutput\b/i]

  it('title + body contain none of the technical terms on the denylist', () => {
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={vi.fn()} />)
    const text = `${screen.getByTestId('nofeed-consent-title').textContent} ${screen.getByTestId('nofeed-consent-body').textContent}`
    for (const term of JARGON_DENYLIST) {
      expect(text).not.toMatch(term)
    }
  })

  it('names the token symbol in the title', () => {
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={vi.fn()} onReject={vi.fn()} />)
    expect(screen.getByTestId('nofeed-consent-title').textContent).toMatch(/ETHFI/)
  })
})
