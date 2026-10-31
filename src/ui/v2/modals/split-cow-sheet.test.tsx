// @vitest-environment jsdom
/**
 * [ADR-025] Frame 27 — the split and CoW review sheets. Both are compared with v1's own modals on the same props (0 missing
 * strings), the per-leg / per-field values are recomputed from the frozen objects, and the unpriced consent gates the split Confirm.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CowOrderReviewModalV1 from '@/components/CowOrderReviewModal'
import SplitReviewModalV1 from '@/components/SplitReviewModal'
import type { PlannedLeg } from '@/hooks/useSplitSwap'
import type { PendingCowOrder } from '@/hooks/useSwap'
import { fmtToken } from '@/lib/format'
import { compareContent } from '../__tests__/content-parity'
import { ETH, USDC } from '../swap/test-fixtures'
import { CowOrderReviewSheet } from './CowOrderReviewSheet'
import { SplitReviewSheet } from './SplitReviewSheet'
import type { ConsentValues } from './review-model'

afterEach(cleanup)

const USER = '0xd44d000000000000000000000000000000000962'
const ROUTER = '0x1111111111111111111111111111111111111111'
const leg = (over: Partial<PlannedLeg>): PlannedLeg =>
  ({
    source: 'velora',
    percent: 60,
    legAmount: 600_000_000_000_000_000n,
    routeViaFeeCollector: true,
    isNativeIn: true,
    routerAddress: ROUTER,
    routerCalldata: '0xdeadbeef' + '00'.repeat(60),
    legMinOutput: 1_488_000_000n,
    expectedOut: '1492610500',
    outputAmount: '1492610500',
    simulated: true,
    status: 'reviewed',
    ...over,
  }) as PlannedLeg
const LEGS = [
  leg({}),
  leg({ source: 'kyberswap', percent: 40, legAmount: 400_000_000_000_000_000n, legMinOutput: 990_000_000n, expectedOut: '995071800', simulated: false }),
  leg({ source: 'sushiswap', percent: 0, status: 'skipped', error: 'Quote expired' }),
]

const norm = (s: string | null | undefined) => (s ?? '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim()

describe('SplitReviewSheet (27, left)', () => {
  it('parity with v1 SplitReviewModal: 0 v1 strings missing', () => {
    const v1 = render(<SplitReviewModalV1 plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={() => {}} />)
    const snap = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<SplitReviewSheet plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={() => {}} />)
    const result = compareContent(snap, v2.container)
    expect(result.missingText).toEqual([])
    expect(result.staleAllow).toEqual([])
  })

  it('title, the v1 sentence with real leg / prompt counts, and a Confirm that counts signable legs', () => {
    render(<SplitReviewSheet plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Review Split Swap' })).toBeTruthy()
    expect(screen.getByText("This routes across 3 legs. Verify each before signing — you'll approve 2 wallet prompts, one per leg.")).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm & Sign 2 legs' })).toBeTruthy()
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1)
  })

  it('per-leg table: each leg shows its own amounts, the enforced minimum, router, recipient, validation; a skipped leg says so and is not counted', () => {
    render(<SplitReviewSheet plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={() => {}} />)
    const l0 = within(screen.getByTestId('split-leg-0'))
    expect(norm(screen.getByTestId('split-leg-0').textContent)).toContain('Leg 1: ')
    expect(l0.getByText(`${fmtToken(600_000_000_000_000_000n, 18)} ETH`)).toBeTruthy()
    expect(norm(screen.getByTestId('split-leg-0').textContent)).toContain(norm(`${fmtToken(1492610500n, 6)} USDC`))
    expect(norm(screen.getByTestId('split-leg-0').textContent)).toContain('Enforced on-chain')
    expect(norm(screen.getByTestId('split-leg-0').textContent)).toContain(norm(`${fmtToken(1_488_000_000n, 6)} USDC`))
    expect(norm(screen.getByTestId('split-leg-0').textContent)).toContain('0x1111...1111')
    expect(norm(screen.getByTestId('split-leg-0').textContent)).toContain('60%')
    // leg 2 simulated inconclusively → v1's fail-open line
    expect(norm(screen.getByTestId('split-leg-1').textContent)).toContain('Simulation unavailable — protected only by the on-chain minimum output.')
    // leg 3 skipped
    expect(norm(screen.getByTestId('split-leg-2').textContent)).toContain('⚠ Skipped — will NOT be signed. Quote expired')
    expect(screen.getByTestId('split-leg-2').textContent).not.toContain('Send')
  })

  it('every leg skipped → nothing to sign: Confirm is disabled; one signable leg → "1 leg"', () => {
    const { rerender } = render(<SplitReviewSheet plannedLegs={[leg({ status: 'skipped' })]} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={() => {}} />)
    expect((screen.getByRole('button', { name: 'Confirm & Sign 0 legs' }) as HTMLButtonElement).disabled).toBe(true)
    rerender(<SplitReviewSheet plannedLegs={[leg({})]} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Confirm & Sign 1 leg' })).toBeTruthy()
    expect(screen.getByText(/one per leg\./).textContent).toContain('1 wallet prompt,')
  })

  it('the unpriced consent gates the split Confirm too (the split hook has its own 409); no consent → Confirm is plain', () => {
    const consent: ConsentValues = { symbolIn: 'ETH', symbolOut: 'USDC', quoteSourceCount: 5, quoteSpreadPct: 0.27, minOut: '2 480.2211' }
    const onConfirm = vi.fn()
    render(<SplitReviewSheet plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} consent={consent} onConfirm={onConfirm} onCancel={() => {}} />)
    const confirm = screen.getByRole('button', { name: 'Confirm & Sign 2 legs' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(screen.getByTestId('unpriced-consent-body').textContent).toContain('5 sources quoted within 0.27% of each other')
    fireEvent.click(screen.getByTestId('unpriced-consent-checkbox'))
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith({ unpricedAck: true })
    cleanup()
    const plain = vi.fn()
    render(<SplitReviewSheet plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={plain} onCancel={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Sign 2 legs' }))
    expect(plain).toHaveBeenCalledWith({ unpricedAck: false })
  })

  it('Esc and Cancel cancel, and focus starts on Cancel', () => {
    const onCancel = vi.fn()
    render(<SplitReviewSheet plannedLegs={LEGS} tokenIn={ETH} tokenOut={USDC} userAddress={USER} onConfirm={() => {}} onCancel={onCancel} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('CowOrderReviewSheet (27, right)', () => {
  const order = {
    message: {
      sellToken: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      buyToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      receiver: USER,
      sellAmount: 1_000_000_000_000_000_000n,
      buyAmount: 2_480_221_200n,
      validTo: Math.floor(Date.now() / 1000) + 30 * 60,
      appData: '0x3f1c000000000000000000000000000000000000000000000000000000000a92e',
      feeAmount: 210_000_000_000_000n,
      kind: 'sell',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
    tokenIn: ETH,
    tokenOut: USDC,
    settlement: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41',
    account: USER,
  } as unknown as PendingCowOrder

  it('parity with v1 CowOrderReviewModal: 0 v1 strings missing, including the explanation sentence', () => {
    const v1 = render(<CowOrderReviewModalV1 order={order} onConfirm={() => {}} onCancel={() => {}} />)
    const snap = v1.container.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<CowOrderReviewSheet order={order} onConfirm={() => {}} onCancel={() => {}} />)
    const result = compareContent(snap, v2.container)
    expect(result.missingText).toEqual([])
    expect(result.staleAllow).toEqual([])
  })

  it("v1's CoW explanation, verbatim", () => {
    render(<CowOrderReviewSheet order={order} onConfirm={() => {}} onCancel={() => {}} />)
    expect(norm(screen.getByTestId('cow-explanation').textContent)).toBe(
      "✓ MEV-protected via CoW Protocol — solvers compete in a batch auction; you're shielded from frontrunning/sandwich attacks. Your wallet signs this order off-chain; no gas to submit.",
    )
    expect(screen.getByRole('dialog', { name: 'Review MEV-Protected Order' })).toBeTruthy()
  })

  it('every field is the frozen order.message, formatted by format.ts', () => {
    render(<CowOrderReviewSheet order={order} onConfirm={() => {}} onCancel={() => {}} />)
    expect(norm(screen.getByTestId('cow-sell').textContent)).toContain(norm(`${fmtToken(1_000_000_000_000_000_000n, 18)} ETH`))
    expect(norm(screen.getByTestId('cow-buy').textContent)).toContain(norm(`${fmtToken(2_480_221_200n, 6)} USDC`))
    expect(norm(screen.getByTestId('cow-fee').textContent)).toContain(norm(`${fmtToken(210_000_000_000_000n, 18)} ETH`))
    expect(screen.getByTestId('cow-receiver').textContent).toBe('0xd44d...0962')
    expect(screen.getByTestId('cow-settlement').textContent).toContain('0x9008...ab41')
    expect(screen.getByTestId('cow-appdata').textContent).toContain('0x3f1c...a92e')
    expect(screen.getByTestId('cow-validto').textContent).toMatch(/\(in ~(29|30) min\)/)
    expect(screen.getByText('Your wallet')).toBeTruthy()
  })

  it('a receiver that is not the signer is flagged Other (v1)', () => {
    render(<CowOrderReviewSheet order={{ ...order, message: { ...order.message, receiver: '0x2222222222222222222222222222222222222222' } } as PendingCowOrder} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByText('Other')).toBeTruthy()
    expect(screen.queryByText('Your wallet')).toBeNull()
  })

  it('Confirm & Sign Order is the one solid CTA (a stub: it calls onConfirm, B5 signs); Cancel / Esc cancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<CowOrderReviewSheet order={order} onConfirm={onConfirm} onCancel={onCancel} />)
    expect(document.querySelectorAll('[data-variant="primary"]').length).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Sign Order' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
