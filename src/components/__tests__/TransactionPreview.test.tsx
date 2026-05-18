// @vitest-environment jsdom
/**
 * [P133 / M-01] TransactionPreview component tests.
 *
 * TransactionPreview is the "clear signing" modal — the user's last visual
 * check before the wallet prompts for a signature. These tests pin the
 * security-critical UI surface:
 *
 *   - Recipient badge: match / feecollector / implicit / other (attacker)
 *   - Minimum output: enforced-on-chain vs degraded (silent 0n)
 *   - Decode failure: warning banner without blocking confirm
 *   - CoW Protocol gasless indicators
 *   - Deadline / expiry rendering
 *
 * The calldata decoder is mocked per-test via vi.mocked().mockReturnValueOnce
 * so each scenario can pin exactly the Preview shape it needs without having
 * to construct real ABI-encoded calldata.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import type { TransactionPreview as Preview } from '@/lib/calldata-decoder'
import { FEE_COLLECTOR_ADDRESS } from '@/lib/constants'
import type { Token } from '@/lib/tokens'

// ── Mock the decoder ───────────────────────────────────────────
// Hoisted by vitest. We control exactly what the component "sees".

vi.mock('@/lib/calldata-decoder', () => ({
  decodeTransactionPreview: vi.fn(),
}))

import { decodeTransactionPreview } from '@/lib/calldata-decoder'
import TransactionPreview from '@/components/TransactionPreview'

// ─── Fixtures ──────────────────────────────────────────────────

const USER_ADDR = '0x1111111111111111111111111111111111111111'
const ATTACKER_ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const ROUTER_ADDR = '0xE592427A0AEce92De3Edee1F18E0157C05861564' // Uniswap V3 router

const TOKEN_IN: Token = {
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`,
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  logoURI: '',
  category: 'Wrapped BTC', // any valid category
}

const TOKEN_OUT: Token = {
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}

const SOME_CALLDATA = '0x04e45aaf' + '00'.repeat(64)

function makePreview(overrides: Partial<Preview> = {}): Preview {
  return {
    sourceDex: 'Uniswap V3',
    functionName: 'exactInputSingle',
    selector: '0x04e45aaf',
    recipient: USER_ADDR,
    recipientType: 'extracted',
    validated: true,
    ...overrides,
  }
}

function renderPreview(props: Partial<Parameters<typeof TransactionPreview>[0]> = {}) {
  const defaults: Parameters<typeof TransactionPreview>[0] = {
    calldata: SOME_CALLDATA,
    routerAddress: ROUTER_ADDR,
    source: '1inch',
    userAddress: USER_ADDR,
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amountInDisplay: '1.0',
    expectedOutput: '3000',
    routeViaFeeCollector: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }
  return render(<TransactionPreview {...defaults} {...props} />)
}

// ═══════════════════════════════════════════════════════════════
// Recipient badge — 4 states (T1-T4)
// ═══════════════════════════════════════════════════════════════

describe('TransactionPreview — recipient badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── T1 ── recipient === user → "Your wallet" badge
  it('shows green "Your wallet" badge when decoded recipient matches userAddress', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({ recipient: USER_ADDR }),
    )

    renderPreview()

    expect(screen.getByText('Your wallet')).toBeInTheDocument()
    // No decode-failure warning
    expect(screen.queryByText(/Could not decode/i)).not.toBeInTheDocument()
  })

  // ── T2 ── recipient === FeeCollector → "FeeCollector" badge
  it('shows gold "FeeCollector" badge when decoded recipient is FEE_COLLECTOR_ADDRESS', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({ recipient: FEE_COLLECTOR_ADDRESS }),
    )

    renderPreview()

    expect(screen.getByText('FeeCollector')).toBeInTheDocument()
  })

  // ── T3 ── recipient === attacker → "Unknown" badge (warning)
  it('shows orange "Unknown" badge when decoded recipient is an unknown address', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({ recipient: ATTACKER_ADDR }),
    )

    renderPreview()

    expect(screen.getByText('Unknown')).toBeInTheDocument()
    // Truncated attacker addr should be in the DOM (0xdead...beef)
    expect(screen.getByText(/0xdead/i)).toBeInTheDocument()
  })

  // ── T4 ── recipient === null → "Implicit" badge (msg.sender)
  it('shows grey "Implicit" badge with msg.sender text when recipient is null', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({ recipient: null, recipientType: 'implicit' }),
    )

    renderPreview()

    expect(screen.getByText('Implicit')).toBeInTheDocument()
    expect(screen.getByText('msg.sender')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════
// Minimum output enforcement (T5-T6)
// ═══════════════════════════════════════════════════════════════

describe('TransactionPreview — minimum output', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── T5 ── minimum output enforced on-chain
  it('shows "Enforced on-chain" badge when routeViaFeeCollector and minimumOutput > 0n', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(makePreview())

    renderPreview({
      routeViaFeeCollector: true,
      minimumOutput: 1_000_000n, // 1 USDC (6 decimals)
    })

    expect(screen.getByText(/Enforced on-chain/i)).toBeInTheDocument()
    // "Minimum output" label visible
    expect(screen.getByText('Minimum output')).toBeInTheDocument()
    // The formatted 1 USDC amount visible
    expect(screen.getByText(/1\s*USDC/i)).toBeInTheDocument()
  })

  // ── T6 ── minimum output 0n → silently degraded (no row)
  it('omits the Enforced on-chain row when minimumOutput is 0n (silent degradation)', () => {
    // Decoder returns no amountOutMin either, so neither minOut row shows.
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(makePreview({ amountOutMin: undefined }))

    renderPreview({
      routeViaFeeCollector: true,
      minimumOutput: 0n,
    })

    expect(screen.queryByText(/Enforced on-chain/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Minimum output')).not.toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════
// Decode failure (T7)
// ═══════════════════════════════════════════════════════════════

describe('TransactionPreview — decode failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── T7 ── functionName='unknown' → warning banner but confirm still active
  it('shows the "Could not decode" warning yet keeps the confirm button enabled', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({
        sourceDex: 'unknown',
        functionName: 'unknown',
        selector: '0xdeadbeef',
        recipient: null,
        validated: false,
        validationReason: 'Unknown selector',
      }),
    )

    renderPreview({ calldata: '0xdeadbeef' })

    // Warning banner present
    expect(screen.getByText(/Could not decode/i)).toBeInTheDocument()

    // Confirm button still rendered and not disabled
    const confirmBtn = screen.getByRole('button', { name: /Confirm/i })
    expect(confirmBtn).toBeInTheDocument()
    expect(confirmBtn).not.toBeDisabled()

    // Raw calldata section accessible (collapse toggle present)
    expect(screen.getByText(/Raw calldata/i)).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════
// CoW gasless display (T8)
// ═══════════════════════════════════════════════════════════════

describe('TransactionPreview — CoW Protocol gasless', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── T8 ── source='cowswap' → "Gasless" chip + "$0.00 (paid by solver)" gas row
  it('shows the "Gasless" chip and $0.00 gas fee paid-by-solver when source is cowswap', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(makePreview())

    renderPreview({ source: 'cowswap' })

    expect(screen.getByText('Gasless')).toBeInTheDocument()
    expect(screen.getByText('Gas fee')).toBeInTheDocument()
    expect(screen.getByText(/\$0\.00/)).toBeInTheDocument()
    expect(screen.getByText(/paid by solver/i)).toBeInTheDocument()
  })

  it('does NOT show the "Gasless" chip when source is not cowswap', () => {
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(makePreview())

    renderPreview({ source: '1inch' })

    expect(screen.queryByText('Gasless')).not.toBeInTheDocument()
    expect(screen.queryByText('Gas fee')).not.toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════
// Deadline display (T9)
// ═══════════════════════════════════════════════════════════════

describe('TransactionPreview — deadline rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows "m remaining" when deadline is ~5 min in the future', () => {
    const future = Math.floor(Date.now() / 1000) + 300
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({ deadline: future }),
    )

    renderPreview()

    expect(screen.getByText('Deadline')).toBeInTheDocument()
    // formatDeadline returns "Xm remaining" for sub-hour ranges
    expect(screen.getByText(/m remaining/i)).toBeInTheDocument()
  })

  it('shows "Expired" when deadline is in the past', () => {
    const past = Math.floor(Date.now() / 1000) - 60
    vi.mocked(decodeTransactionPreview).mockReturnValueOnce(
      makePreview({ deadline: past }),
    )

    renderPreview()

    expect(screen.getByText('Expired')).toBeInTheDocument()
  })
})
