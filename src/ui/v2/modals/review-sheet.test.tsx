// @vitest-environment jsdom
/**
 * [ADR-025] Frames 26 / m03 — the review sheet. (1) Every field equals what the quote object says (an independent recomputation
 * from the fixture, and the same strings the quote panel shows). (2) The calldata half is v1's TransactionPreview — compared
 * against v1's own component on the same props. (3) The unpriced consent gates Confirm, with the REAL {N} / {d} / {minOut}; a
 * server 409 brings it back unticked and reopens the sheet.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatUnits } from 'viem'
import TransactionPreviewV1 from '@/components/TransactionPreview'
import { unpricedConsentCopy, UNPRICED_CONSENT_CHECKBOX, UNPRICED_CONSENT_HEADING } from '@/components/SwapUnpricedConsentDialog'
import { deriveMinimumOutput } from '@/lib/minimum-output'
import { fmtPct, fmtToken } from '@/lib/format'
import type { SwapPriceTierResponse } from '@/lib/swap-price-tier'
import { compareContent, visibleText } from '../__tests__/content-parity'
import { buildQuoteView } from '../swap/quote-model'
import { QuotePanel } from '../swap/QuotePanel'
import { ETH, USDC, NO_ORACLE, fixtureMeta } from '../swap/test-fixtures'
import { SINGLE_SOURCE_TAIL } from '../swap/TierNotice'
import { ReviewSheet, type ReviewPending } from './ReviewSheet'
import { buildReviewModel, consentRequired, reviewOpen, unpricedConsentValues } from './review-model'

afterEach(cleanup)

const meta = fixtureMeta()
const gasEstimate = () => ({ eth: 0.000012, usd: 0.03 })
const view = (slippage = 0.3, m = meta) =>
  buildQuoteView({ meta: m, tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage, chainId: 1, tokenInUsdPrice: 2490, tokenOutUsdPrice: 1, gasEstimate })
const model = (tier: SwapPriceTierResponse | null = null, slippage = 0.3, m = meta) => buildReviewModel({ view: view(slippage, m), meta: m, tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage, tier })

const UNPRICED = { tier: 'unpriced' } as unknown as SwapPriceTierResponse
const SINGLE = {
  tier: 'single-source',
  legs: { in: { tier: 'single-source', sources: ['defillama'] }, out: { tier: 'priced', sources: ['chainlink', 'coingecko'] } },
} as unknown as SwapPriceTierResponse

/** A row's visible text: its text nodes joined by one space, every kind of space folded to U+0020 (so assertions read like the screen). */
const cell = (id: string) => {
  const el = screen.getByTestId(id)
  const out: string[] = []
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = (n.textContent ?? '').replace(/[\u00a0\u2009\u202f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (t) out.push(t)
  }
  return out.join(' ')
}
const sp = (x: string) => x.replace(/[\u00a0\u2009\u202f]/g, ' ')

describe('fields match the quote object', () => {
  it('Send / Receive / Rate / Route / Max slippage / Min. output / Fee / Est. gas, recomputed from the fixture', () => {
    render(<ReviewSheet model={model()} onConfirm={() => {}} onCancel={() => {}} />)
    const best = meta.best
    const expectedOut = fmtToken(BigInt(best.toAmount), USDC.decimals)
    expect(cell('review-send')).toBe(`Send ${sp(fmtToken(10n ** 18n, 18))} ETH`)
    expect(cell('review-receive')).toBe(`Receive (est.) ${sp(expectedOut)} USDC`)
    expect(sp(expectedOut)).toBe('2 487.6842')
    expect(cell('review-rate')).toBe(`Rate 1 ETH = ${sp(fmtToken(Number(formatUnits(BigInt(best.toAmount), 6))))} USDC`)
    expect(cell('review-route')).toContain('Dexalot + PancakeSwap V3 + Dexalot')
    expect(cell('review-slippage')).toContain('0.3%')
    // [A69 H-1] No minimum-output row before the hook has frozen the transaction: the sheet never shows a figure it computed itself.
    expect(screen.queryByTestId('review-min')).toBeNull()
    expect(screen.queryByTestId('review-min-pending')).toBeNull()
    expect(cell('review-fee')).toBe('Platform fee (0.1%) 0.001 ETH ($2.49)')
    expect(cell('review-gas')).toBe('Est. gas $0.03 (~0.000012 ETH)')
    expect(screen.getByRole('dialog', { name: 'Review Transaction' })).toBeTruthy()
    expect(screen.getByText('Verify the details before signing')).toBeTruthy()
  })

  it('the same strings the quote panel shows for the same quote (no second set of numbers)', () => {
    const v = view()
    const panel = render(
      <QuotePanel view={v} symbolIn="ETH" symbolOut="USDC" countdown={9} onRefresh={() => {}} refreshing={false} priceCheck={NO_ORACLE as never} approvalPlan={null} onEditSlippage={() => {}} smartMevApplied={false} gasless={undefined} lowConfidence={false} sourceCount={5} onUseGasless={() => {}} />,
    )
    const panelText = visibleText(panel.container)
    cleanup()
    render(<ReviewSheet model={model()} onConfirm={() => {}} onCancel={() => {}} />)
    const dlg = visibleText(screen.getByRole('dialog'))
    for (const x of [v.rate, v.route, v.slippage, v.gas, v.feeLabel, v.feeValue!]) expect(dlg).toContain(sp(x).toLowerCase())
    for (const x of [v.rate, v.route, v.slippage, v.gas, v.feeValue!, v.minOutput]) expect(panelText).toContain(sp(x).toLowerCase())
  })

  it('the minimum output is the bigint floor (deriveMinimumOutput), exact at 14 digits, and follows the slippage', () => {
    const big = fixtureMeta()
    big.best = { ...big.best, toAmount: '12345678901234' } // 12 345 678.901234 USDC
    big.all = [big.best, ...big.all.slice(1)]
    const at = (slippage: number) => buildReviewModel({ view: view(slippage, big), meta: big, tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage, tier: null }).minOutput
    expect(at(1)).toBe(fmtToken(deriveMinimumOutput('12345678901234', 1), 6))
    // floor(12 345 678 901 234 × 9 900 / 10 000) = 12 222 222 112 221 → 12 222 222.112221 USDC → 4 dp
    expect(sp(at(1))).toBe('12 222 222.1122')
    expect(at(3)).not.toBe(at(1)) // a different slippage is a different floor
  })

  it('a CoW (intent) quote: Gasless chip and v1\'s "$0.00 (paid by solver)" gas line', () => {
    const cow = fixtureMeta()
    cow.best = { ...cow.best, source: 'cowswap', estimatedGas: 0 }
    cow.all = [cow.best, ...cow.all.slice(1)]
    render(<ReviewSheet model={buildReviewModel({ view: view(0.3, cow), meta: cow, tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage: 0.3, tier: null })} onConfirm={() => {}} onCancel={() => {}} />)
    expect(cell('review-source')).toContain('Gasless')
    expect(cell('review-cow-gas')).toBe('Gas fee $0.00 (paid by solver)')
  })

  it('without frozen calldata (B4) the decoded rows are absent — no recipient / validation is claimed that was not decoded', () => {
    render(<ReviewSheet model={model()} onConfirm={() => {}} onCancel={() => {}} />)
    for (const id of ['review-recipient', 'review-validation', 'review-selector', 'review-decoded']) expect(screen.queryByTestId(id)).toBeNull()
  })
})

describe('the calldata half is v1 TransactionPreview (parity on the same props)', () => {
  const USER = '0xd44d000000000000000000000000000000000962'
  const pending: ReviewPending = {
    calldata: '0xdeadbeef' + '00'.repeat(60),
    routerAddress: '0x1111111111111111111111111111111111111111',
    source: 'velora',
    userAddress: USER,
    routeViaFeeCollector: true,
    minimumOutput: 2_480_221_200n,
    decimalsOut: 6,
    tokenOutAddress: USDC.address,
  }
  const v1Props = {
    calldata: pending.calldata,
    routerAddress: pending.routerAddress,
    source: pending.source,
    userAddress: USER,
    tokenIn: ETH,
    tokenOut: USDC,
    amountInDisplay: '1',
    expectedOutput: '2 487.6842',
    routeViaFeeCollector: true,
    minimumOutput: pending.minimumOutput,
    onConfirm: () => {},
    onCancel: () => {},
  }

  it('0 v1 strings missing: source, send/receive, enforced minimum, route, validation, selector, raw calldata, buttons', () => {
    const v1 = render(<TransactionPreviewV1 {...v1Props} />)
    const snap = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<ReviewSheet model={model()} pending={pending} onConfirm={() => {}} onCancel={() => {}} />)
    const result = compareContent(snap, v2.container, [
      // v1 renders the raw-calldata chevron from an entity inside a JS string ('&#9660;' literal) — a v1 quirk; v2 draws ▼/▲.
      { text: '&#9660;', reason: 'v1 bug: the chevron is an unescaped entity string; v2 renders the glyph' },
      { text: '⚠', reason: 'decorative marker, aria-hidden in v2 (its line starts with the validation reason)' },
    ])
    expect(result.missingText).toEqual([])
    expect(result.staleAllow).toEqual([])
  })

  it('the enforced minimum (FeeCollector) wins and is badged; it is the frozen value, not the displayed floor', () => {
    render(<ReviewSheet model={model()} pending={{ ...pending, minimumOutput: 2_400_000_000n }} onConfirm={() => {}} onCancel={() => {}} />)
    expect(cell('review-min')).toContain('Enforced on-chain')
    expect(cell('review-min')).toBe('Minimum output Enforced on-chain 2 400.0000 USDC')
    cleanup()
    render(<ReviewSheet model={model()} pending={{ ...pending, routeViaFeeCollector: false }} onConfirm={() => {}} onCancel={() => {}} />)
    // Direct route + calldata that decodes to nothing: no row at all (A69 H-1 — never a UI-computed fallback).
    expect(screen.queryByTestId('review-min')).toBeNull()
  })

  it('an undecodable calldata gets v1\'s warning and still lets the user read the raw bytes', () => {
    render(<ReviewSheet model={model()} pending={pending} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('Could not decode transaction details. Verify in your wallet before signing.')).toBeTruthy()
    // 65, not 64: v1 counts `calldata.length / 2` including the 0x prefix — copied as-is (parity), recorded as a v1 finding.
    expect(screen.getByRole('button', { name: /Raw calldata \(65 bytes\)/ }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: /Raw calldata/ }))
    expect(screen.getByText(pending.calldata)).toBeTruthy()
  })
})

describe('tier line, consent, Confirm', () => {
  const NOTE_COPY = (m: ReturnType<typeof model>) => unpricedConsentCopy(m.consent)

  it('priced / unknown: no consent, no notice, Confirm enabled → onConfirm({unpricedAck:false})', () => {
    const onConfirm = vi.fn()
    render(<ReviewSheet model={model(null)} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.queryByTestId('unpriced-consent')).toBeNull()
    expect(screen.queryByTestId('price-tier-single-source')).toBeNull()
    const confirm = screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith({ unpricedAck: false })
  })

  it("single-source: v1's amber line (vendor named), no consent, Confirm enabled", () => {
    render(<ReviewSheet model={model(SINGLE)} onConfirm={() => {}} onCancel={() => {}} />)
    const line = screen.getByTestId('price-tier-single-source')
    expect(line.textContent).toContain('Price from one source only (DefiLlama).')
    expect(line.textContent).toContain(SINGLE_SOURCE_TAIL)
    expect(screen.queryByTestId('unpriced-consent')).toBeNull()
    expect((screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('unpriced: the consent block carries v1\'s heading, checkbox label and body with the real {N} / {d} / {minOut}', () => {
    const m = model(UNPRICED)
    render(<ReviewSheet model={m} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByTestId('unpriced-consent-heading').textContent).toBe(UNPRICED_CONSENT_HEADING)
    expect(screen.getByLabelText(UNPRICED_CONSENT_CHECKBOX)).toBeTruthy()
    const body = screen.getByTestId('unpriced-consent-body').textContent!
    expect(body).toBe(NOTE_COPY(m))
    // Independent recomputation of the three values from the fixture's five quotes.
    const outs = meta.all.map((q) => BigInt(q.toAmount))
    const lo = outs.reduce((a, b) => (b < a ? b : a))
    const hi = outs.reduce((a, b) => (b > a ? b : a))
    const spread = fmtPct(Number(((hi - lo) * 1_000_000n) / lo) / 10_000, 2)
    expect(spread).toBe('0.27%')
    expect(body).toContain(`5 sources quoted within ${spread} of each other`)
    expect(body).toContain(`on-chain minimum output of ${fmtToken(deriveMinimumOutput(meta.best.toAmount, 0.3), 6)} USDC`)
    expect(body).toContain("We couldn't find a Chainlink, DefiLlama or CoinGecko price for ETH or USDC")
    expect(m.consent).toEqual({ symbolIn: 'ETH', symbolOut: 'USDC', quoteSourceCount: 5, quoteSpreadPct: Number(((hi - lo) * 1_000_000n) / lo) / 10_000, minOut: fmtToken(deriveMinimumOutput(meta.best.toAmount, 0.3), 6) })
  })

  it('a single quote says what is true (v1 wording) and never "1 sources"', () => {
    const one = fixtureMeta()
    one.all = [one.best]
    const m = model(UNPRICED, 0.3, one)
    expect(m.consent.quoteSourceCount).toBe(1)
    expect(m.consent.quoteSpreadPct).toBe(0)
    render(<ReviewSheet model={m} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByTestId('unpriced-consent-body').textContent).toContain('1 source quoted (no second quote to compare against)')
  })

  it('the consent GATES Confirm: disabled until the box is ticked; ticked → onConfirm({unpricedAck:true}); untick → disabled again', () => {
    const onConfirm = vi.fn()
    render(<ReviewSheet model={model(UNPRICED)} onConfirm={onConfirm} onCancel={() => {}} />)
    const confirm = screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onConfirm).not.toHaveBeenCalled()
    const box = screen.getByTestId('unpriced-consent-checkbox') as HTMLInputElement
    fireEvent.click(box)
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith({ unpricedAck: true })
    fireEvent.click(box)
    expect(confirm.disabled).toBe(true)
  })

  it('409 unpriced_ack_required on a PRICED pair: the consent appears, unticked, and gates Confirm', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<ReviewSheet model={model(null)} ackRequired={false} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.queryByTestId('unpriced-consent')).toBeNull()
    rerender(<ReviewSheet model={model(null)} ackRequired onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByTestId('unpriced-consent')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a 409 after an earlier tick voids the tick (a fresh question), and Confirm needs it again', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(<ReviewSheet model={model(UNPRICED)} ackRequired={false} onConfirm={onConfirm} onCancel={() => {}} />)
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    expect((screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement).disabled).toBe(false)
    rerender(<ReviewSheet model={model(UNPRICED)} ackRequired onConfirm={onConfirm} onCancel={() => {}} />)
    expect((screen.getByTestId('unpriced-consent-checkbox') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('button', { name: 'Confirm & Sign' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a 409 REOPENS a cancelled review (v1: requested || ackRequired)', () => {
    expect(reviewOpen({ requested: false, ackRequired: false })).toBe(false)
    expect(reviewOpen({ requested: true, ackRequired: false })).toBe(true)
    expect(reviewOpen({ requested: false, ackRequired: true })).toBe(true)
    function Host({ ack }: { ack: boolean }) {
      const [requested, setRequested] = useState(true)
      return reviewOpen({ requested, ackRequired: ack }) ? <ReviewSheet model={model(null)} ackRequired={ack} onConfirm={() => {}} onCancel={() => setRequested(false)} /> : <span>closed</span>
    }
    const { rerender } = render(<Host ack={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('closed')).toBeTruthy()
    rerender(<Host ack />)
    expect(screen.getByRole('dialog', { name: 'Review Transaction' })).toBeTruthy()
    expect(screen.getByTestId('unpriced-consent')).toBeTruthy()
  })

  it('consentRequired: unpriced tier or a server ask; nothing else', () => {
    expect(consentRequired({ tier: UNPRICED }, false)).toBe(true)
    expect(consentRequired({ tier: null }, true)).toBe(true)
    expect(consentRequired({ tier: SINGLE }, false)).toBe(false)
    expect(consentRequired({ tier: null }, false)).toBe(false)
  })

  it('unpricedConsentValues ignores malformed / zero quotes when counting', () => {
    const odd = fixtureMeta()
    odd.all = [odd.all[0], { ...odd.all[1], toAmount: 'oops' }, { ...odd.all[2], toAmount: '0' }]
    expect(unpricedConsentValues(odd, ETH, USDC, 0.3).quoteSourceCount).toBe(1)
  })
})

describe('chrome and keyboard', () => {
  it('Confirm is the screen\'s ONE solid cream CTA; Cancel is a text button and holds the initial focus', () => {
    render(<ReviewSheet model={model()} onConfirm={() => {}} onCancel={() => {}} />)
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1)
    expect(screen.getByRole('button', { name: 'Confirm & Sign' }).getAttribute('data-variant')).toBe('primary')
    expect(screen.getByRole('button', { name: 'Cancel' }).getAttribute('data-variant')).toBe('text')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('Esc and Cancel cancel; the dimmed page cancels; Tab never leaves the sheet', () => {
    const onCancel = vi.fn()
    render(<ReviewSheet model={model(UNPRICED)} onConfirm={() => {}} onCancel={onCancel} />)
    const dlg = screen.getByRole('dialog')
    const items = Array.from(dlg.querySelectorAll<HTMLElement>('button:not([disabled]), input'))
    items[items.length - 1].focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab' })
    expect(dlg.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(document.querySelector('[data-sheet-backdrop]') as HTMLElement)
    expect(onCancel).toHaveBeenCalledTimes(3)
  })
})
