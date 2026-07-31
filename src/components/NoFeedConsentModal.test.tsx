// @vitest-environment jsdom
/**
 * [FIX-DCA-NOFEED-CONSENT] NoFeedConsentModal — unit tests for the standalone component
 * (focus/Esc/Accept-Reject wiring). The end-to-end DCAPanel wiring (golden ETHFI case,
 * feed-covered byte-identical path, jargon denylist) lives in DCAPanel.nofeed-consent.test.tsx.
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

  it('clicking the backdrop triggers onReject (never onAccept)', () => {
    const onAccept = vi.fn()
    const onReject = vi.fn()
    render(<NoFeedConsentModal open tokenSymbol="ETHFI" onAccept={onAccept} onReject={onReject} />)
    fireEvent.click(screen.getByRole('presentation'))
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onAccept).not.toHaveBeenCalled()
  })
})
