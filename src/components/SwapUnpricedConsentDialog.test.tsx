// @vitest-environment jsdom
/**
 * [feat/swap-price-tiers D3] Informed consent for a swap whose pair has NO reference price on either leg.
 * Owner copy verbatim (2026-10-26); every placeholder is a REAL value from the live quote.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import SwapUnpricedConsentDialog, {
  UNPRICED_CONSENT_CHECKBOX, UNPRICED_CONSENT_HEADING, unpricedConsentCopy,
} from './SwapUnpricedConsentDialog'

const props = () => ({
  symbolIn: 'AERO', symbolOut: 'ETHFI', quoteSourceCount: 3, quoteSpreadPct: 0.42, minOut: '1 234.5678',
  onConfirm: vi.fn(), onCancel: vi.fn(),
})

describe('SwapUnpricedConsentDialog — owner copy with real values', () => {
  it('heading, body and checkbox carry the owner copy; {A} {B} {N} {d} {minOut} are the real values', () => {
    renderWithProviders(<SwapUnpricedConsentDialog {...props()} />)
    expect(screen.getByTestId('unpriced-consent-heading').textContent).toBe('No reference price for this pair')
    expect(screen.getByTestId('unpriced-consent-body').textContent).toBe(
      "We couldn't find a Chainlink, DefiLlama or CoinGecko price for AERO or ETHFI, so we can't estimate this trade's USD value or apply value-based limits. " +
      'What still protects you: 3 sources quoted within 0.42% of each other, and the on-chain minimum output of 1 234.5678 ETHFI — if a fill would return less, the transaction reverts.',
    )
    expect(screen.getByLabelText('I understand — continue')).toBeInTheDocument()
    expect(UNPRICED_CONSENT_HEADING).toBe('No reference price for this pair')
    expect(UNPRICED_CONSENT_CHECKBOX).toBe('I understand — continue')
  })

  it('Continue stays disabled until the checkbox is ticked, then confirms exactly once', () => {
    const p = props()
    renderWithProviders(<SwapUnpricedConsentDialog {...p} />)
    const confirm = screen.getByTestId('unpriced-consent-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(p.onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(p.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Cancel and Escape cancel; Cancel holds the initial focus (the safe default)', () => {
    const p = props()
    renderWithProviders(<SwapUnpricedConsentDialog {...p} />)
    expect(document.activeElement).toBe(screen.getByTestId('unpriced-consent-cancel'))
    fireEvent.click(screen.getByTestId('unpriced-consent-cancel'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(p.onCancel).toHaveBeenCalledTimes(2)
    expect(p.onConfirm).not.toHaveBeenCalled()
  })

  it('is a labelled modal dialog', () => {
    renderWithProviders(<SwapUnpricedConsentDialog {...props()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('unpriced-consent-heading')
    expect(dialog.getAttribute('aria-describedby')).toBe('unpriced-consent-body')
  })

  it('with ONE quote source the protection clause says so instead of "1 sources quoted within 0%"', () => {
    expect(unpricedConsentCopy({ symbolIn: 'A', symbolOut: 'B', quoteSourceCount: 1, quoteSpreadPct: 0, minOut: '5' }))
      .toContain('What still protects you: 1 source quoted (no second quote to compare against), and the on-chain minimum output of 5 B')
  })

  it('spread: at most 2 decimals, trailing zeros trimmed', () => {
    const copy = (d: number) => unpricedConsentCopy({ symbolIn: 'A', symbolOut: 'B', quoteSourceCount: 2, quoteSpreadPct: d, minOut: '5' })
    expect(copy(1.5)).toContain('2 sources quoted within 1.5% of each other')
    expect(copy(0.123456)).toContain('within 0.12% of each other')
    expect(copy(2)).toContain('within 2% of each other')
  })
})
