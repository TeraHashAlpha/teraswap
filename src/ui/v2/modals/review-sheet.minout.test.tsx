// @vitest-environment jsdom
/**
 * [A69 H-1] Minimum output on the review sheet. v1's TransactionPreview shows the FeeCollector-enforced minimum, else the router floor
 * DECODED FROM THE FROZEN CALLDATA (`preview.amountOutMin`, TransactionPreview.tsx:113,208-213) — never a figure the UI computed from
 * the quote. The same frozen preview goes to both components here (the decoder is stubbed so the preview is exact), and a spy on
 * `fmtToken` records the BIGINT each one formats: parity is bigint equality, not string equality.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TransactionPreviewV1 from '@/components/TransactionPreview'
import { buildQuoteView } from '../swap/quote-model'
import { ETH, USDC, fixtureMeta } from '../swap/test-fixtures'
import { ReviewSheet, type ReviewPending } from './ReviewSheet'
import { buildReviewModel, decodedMinimumOutput } from './review-model'

const h = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  fmt: [] as Array<{ v: unknown; d: unknown }>,
}))

vi.mock('@/lib/calldata-decoder', async (orig) => ({
  ...(await orig<typeof import('@/lib/calldata-decoder')>()),
  decodeTransactionPreview: () => h.preview,
}))
vi.mock('@/lib/format', async (orig) => {
  const actual = await orig<typeof import('@/lib/format')>()
  return {
    ...actual,
    fmtToken: (...a: Parameters<typeof actual.fmtToken>) => {
      h.fmt.push({ v: a[0], d: a[1] })
      return actual.fmtToken(...a)
    },
  }
})

const USER = '0xd44d000000000000000000000000000000000962'
const ROUTER_FLOOR = 2_480_221_147n // 2 487.6842 USDC × (1 − 0.3 %), the integer floor a router would encode
const FEE_COLLECTOR_FLOOR = 2_400_000_000n
const decoded = (over: Record<string, unknown> = {}) => ({
  sourceDex: '0x',
  functionName: 'swap',
  selector: '0x12345678',
  recipient: USER,
  validated: true,
  tokenIn: ETH.address,
  tokenOut: USDC.address,
  amountOutMin: ROUTER_FLOOR.toString(),
  ...over,
})

const meta = fixtureMeta()
const gasEstimate = () => ({ eth: 0.000012, usd: 0.03 })
const model = () => {
  const view = buildQuoteView({ meta, tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage: 0.3, chainId: 1, tokenInUsdPrice: 2490, tokenOutUsdPrice: 1, gasEstimate })
  return buildReviewModel({ view, meta, tokenIn: ETH, tokenOut: USDC, amountIn: '1', slippage: 0.3, tier: null })
}
const pendingFor = (over: Partial<ReviewPending> = {}): ReviewPending => ({
  calldata: '0x12345678' + '00'.repeat(64),
  routerAddress: '0x1111111111111111111111111111111111111111',
  source: '0x',
  userAddress: USER,
  routeViaFeeCollector: false,
  decimalsOut: USDC.decimals,
  tokenOutAddress: USDC.address,
  ...over,
})
const v1Props = (p: ReviewPending) => ({
  calldata: p.calldata,
  routerAddress: p.routerAddress,
  source: p.source,
  userAddress: p.userAddress,
  tokenIn: ETH,
  tokenOut: USDC,
  amountInDisplay: '1',
  expectedOutput: '2 487.6842',
  routeViaFeeCollector: p.routeViaFeeCollector,
  minimumOutput: p.minimumOutput,
  onConfirm: () => {},
  onCancel: () => {},
})

/** What each component handed `fmtToken` for the same frozen preview (the model is built first, so its own formatting is not counted). */
function formatted(p: ReviewPending) {
  const m = model()
  h.fmt.length = 0
  render(<TransactionPreviewV1 {...v1Props(p)} />)
  const v1 = [...h.fmt]
  cleanup()
  h.fmt.length = 0
  render(<ReviewSheet model={m} pending={p} onConfirm={() => {}} onCancel={() => {}} />)
  const v2 = [...h.fmt]
  return { v1, v2 }
}

beforeEach(() => {
  h.preview = decoded()
})
afterEach(cleanup)

describe('direct route (not via the FeeCollector): the decoded router floor', () => {
  it('v1 == v2 on the same frozen preview — the SAME bigint reaches the formatter (not the UI\'s quote × (1 − slippage))', () => {
    const { v1, v2 } = formatted(pendingFor())
    expect(v1).toEqual([{ v: ROUTER_FLOOR, d: 6 }])
    expect(v2).toEqual(v1)
    const row = screen.getByTestId('review-min')
    expect(row.textContent?.replace(/[   ]/g, ' ')).toBe('Minimum output2 480.2211 USDC')
    expect(screen.queryByText('Enforced on-chain')).toBeNull()
  })

  it('it is the calldata\'s value, not the UI\'s: a router floor 1 wei off the UI derivation still shows as decoded', () => {
    h.preview = decoded({ amountOutMin: (ROUTER_FLOOR - 123_456_789n).toString() })
    const { v1, v2 } = formatted(pendingFor())
    expect(v2).toEqual(v1)
    expect(v2).toEqual([{ v: ROUTER_FLOOR - 123_456_789n, d: 6 }])
  })

  it('a decoded buy token that is not the token being bought hides the row, as v1 does', () => {
    h.preview = decoded({ tokenOut: ETH.address })
    const { v1, v2 } = formatted(pendingFor())
    expect(v1).toEqual([])
    expect(v2).toEqual([])
    expect(screen.queryByTestId('review-min')).toBeNull()
  })

  it('a zero or non-integer decoded floor shows no row (v1: formatDecodedAmount → null)', () => {
    for (const amountOutMin of ['0', 'not-a-number', undefined]) {
      h.preview = decoded({ amountOutMin })
      render(<ReviewSheet model={model()} pending={pendingFor()} onConfirm={() => {}} onCancel={() => {}} />)
      expect(screen.queryByTestId('review-min')).toBeNull()
      cleanup()
    }
  })

  it('decodedMinimumOutput returns the exact bigint (no float round-trip) at 30 digits', () => {
    const big = 123_456_789_012_345_678_901_234_567_890n
    expect(decodedMinimumOutput({ amountOutMin: big.toString(), tokenOut: USDC.address.toUpperCase() }, USDC.address.toLowerCase())).toBe(big)
  })
})

describe('FeeCollector route: unchanged — the enforced minimum wins, badged', () => {
  it('v1 == v2: the enforced bigint is formatted, the decoded floor is not', () => {
    const { v1, v2 } = formatted(pendingFor({ routeViaFeeCollector: true, minimumOutput: FEE_COLLECTOR_FLOOR }))
    // v1 also formats the decoded floor eagerly on every render (it just does not display it here); v2 formats only what it displays.
    expect(v1).toContainEqual({ v: FEE_COLLECTOR_FLOOR, d: 6 })
    expect(v2).toEqual([{ v: FEE_COLLECTOR_FLOOR, d: 6 }])
    expect(v2.some((c) => c.v === ROUTER_FLOOR)).toBe(false)
    expect(screen.getByTestId('review-min').textContent).toContain('Enforced on-chain')
  })

  it('FeeCollector route without an enforced figure falls back to the decoded floor, as v1 does', () => {
    const { v1, v2 } = formatted(pendingFor({ routeViaFeeCollector: true, minimumOutput: undefined }))
    expect(v1).toEqual([{ v: ROUTER_FLOOR, d: 6 }])
    expect(v2).toEqual(v1)
    expect(screen.getByTestId('review-min').textContent).not.toContain('Enforced on-chain')
  })
})

describe('before the transaction is frozen', () => {
  it('the hook is working (no pending yet): a skeleton in the row, no number', () => {
    render(<ReviewSheet model={model()} confirmBusy confirmLabel="Preparing swap..." onConfirm={() => {}} onCancel={() => {}} />)
    const row = screen.getByTestId('review-min-pending')
    expect(row.textContent).toBe('Minimum output')
    expect(row.querySelector('.ts-v2-skeleton')).not.toBeNull()
    expect(screen.queryByTestId('review-min')).toBeNull()
  })

  it('nothing frozen and nothing in flight: NO row — never a UI-computed fallback', () => {
    render(<ReviewSheet model={model()} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId('review-min')).toBeNull()
    expect(screen.queryByTestId('review-min-pending')).toBeNull()
    expect(screen.getByRole('dialog').textContent).not.toContain('Minimum output')
  })

  it('a frozen preview that could not be decoded: no row either (the amber warning is the signal)', () => {
    h.preview = decoded({ functionName: 'unknown', amountOutMin: undefined, tokenOut: undefined })
    render(<ReviewSheet model={model()} pending={pendingFor()} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByTestId('review-min')).toBeNull()
    expect(screen.getByText('Could not decode transaction details. Verify in your wallet before signing.')).toBeTruthy()
  })
})
