// @vitest-environment jsdom
/**
 * [P115/M-01] TransactionPreview — clear-signing modal.
 *
 * The modal is the last surface the user sees before they sign. Tests
 * pin the security-relevant rendering:
 *
 *   - Recipient badge differentiates: user wallet / FeeCollector /
 *     other / implicit (no decoded recipient).
 *   - FeeCollector-enforced minimumOutput is shown in human-readable
 *     form with the "Enforced on-chain" chip.
 *   - Decode-failure path: when the decoder can't read the calldata,
 *     a clear warning surfaces but the modal still renders (user can
 *     still choose to sign).
 *   - CoW gasless chip + "$0.00 (paid by solver)" line appear when
 *     source='cowswap'.
 *   - Confirm + Cancel buttons fire their respective handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// Mock the calldata decoder so we can control what fields appear in
// the preview without crafting real swap calldata for each branch.
type DecodedPreview = {
  functionName: string
  selector: string
  sourceDex: string
  recipient: string | null
  validated: boolean
  validationReason?: string
  tokenIn?: string
  amountIn?: string
  tokenOut?: string
  amountOutMin?: string
  deadline?: number | null
}

let mockDecoded: DecodedPreview = {
  functionName: 'swap',
  selector: '0x1234abcd',
  sourceDex: 'Mock DEX',
  recipient: null,
  validated: true,
}

vi.mock('@/lib/calldata-decoder', () => ({
  decodeTransactionPreview: vi.fn(() => mockDecoded),
}))

// FeeCollector address constant — must match the value the component
// imports so the "FeeCollector" badge branch fires. The vi.mock factory
// is hoisted above this file's locals, so the address is inlined inside
// the factory and re-exported as the FEE_COLLECTOR test constant below.
vi.mock('@/lib/constants', async () => {
  const actual = await vi.importActual<typeof import('@/lib/constants')>('@/lib/constants')
  return {
    ...actual,
    FEE_COLLECTOR_ADDRESS: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459',
  }
})
const FEE_COLLECTOR = '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459'

import TransactionPreview from './TransactionPreview'
import type { Token } from '@/lib/tokens'

const USER = '0x1111111111111111111111111111111111111111'

const USDC: Token = {
  address: '0xa0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  logoURI: '',
  category: 'Stablecoin',
}
const ETH: Token = {
  address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  symbol: 'ETH',
  name: 'Ether',
  decimals: 18,
  logoURI: '',
  category: 'Native',
}

const baseProps = {
  calldata: '0x1234abcd' + '0'.repeat(128),
  routerAddress: '0x1111111125421ca6dc452d289314280a0f8842a65',
  source: '1inch',
  userAddress: USER,
  tokenIn: USDC,
  tokenOut: ETH,
  amountInDisplay: '1000',
  expectedOutput: '0.5',
  routeViaFeeCollector: false,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDecoded = {
    functionName: 'swap',
    selector: '0x1234abcd',
    sourceDex: 'Mock DEX',
    recipient: null,
    validated: true,
  }
})

describe('TransactionPreview', () => {
  it('renders the dialog with the header + send/receive amounts', () => {
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByRole('dialog', { name: /review transaction/i })).toBeInTheDocument()
    expect(screen.getByText('1000 USDC')).toBeInTheDocument()
    expect(screen.getByText('0.5 ETH')).toBeInTheDocument()
  })

  it("shows 'Your wallet' badge when recipient === userAddress", () => {
    mockDecoded.recipient = USER
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByText(/your wallet/i)).toBeInTheDocument()
  })

  it("shows 'FeeCollector' badge when recipient is the FeeCollector contract", () => {
    mockDecoded.recipient = FEE_COLLECTOR
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByText('FeeCollector')).toBeInTheDocument()
  })

  it("shows 'Unknown' badge when recipient is some other address", () => {
    mockDecoded.recipient = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead'
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByText(/unknown/i)).toBeInTheDocument()
  })

  it("shows 'Implicit' badge + 'Your wallet (implicit)' text when no recipient was decoded", () => {
    mockDecoded.recipient = null
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByText(/implicit/i)).toBeInTheDocument()
  })

  it('renders the FeeCollector-enforced minimumOutput in human-readable form', () => {
    // 0.42 ETH (18 dp)
    render(
      <TransactionPreview
        {...baseProps}
        routeViaFeeCollector
        minimumOutput={420_000_000_000_000_000n}
      />,
    )
    expect(screen.getByText(/enforced on-chain/i)).toBeInTheDocument()
    // 0.42 with up to 6 decimals, may render with locale separator.
    expect(screen.getByText(/0[.,]42\s*ETH/)).toBeInTheDocument()
  })

  it("falls back to the calldata-decoded amountOutMin when not routed via FeeCollector", () => {
    // 0.4 ETH (18dp): 4 * 10^17 = 400000000000000000
    mockDecoded.tokenOut = ETH.address
    mockDecoded.amountOutMin = '400000000000000000'
    render(<TransactionPreview {...baseProps} />)
    // Two text matches possible — at least one matches the decoded amount.
    expect(screen.getByText(/0[.,]4\s*ETH/)).toBeInTheDocument()
  })

  it("surfaces the decode-failure warning when functionName='unknown'", () => {
    mockDecoded.functionName = 'unknown'
    render(<TransactionPreview {...baseProps} />)
    expect(
      screen.getByText(/could not decode transaction details/i),
    ).toBeInTheDocument()
  })

  it('renders the gasless chip + $0.00 gas line when source=cowswap', () => {
    render(<TransactionPreview {...baseProps} source="cowswap" />)
    expect(screen.getByText(/^gasless$/i)).toBeInTheDocument()
    expect(screen.getByText(/\$0\.00/)).toBeInTheDocument()
    expect(screen.getByText(/paid by solver/i)).toBeInTheDocument()
  })

  it('does NOT render the gasless chip for non-CoW sources', () => {
    render(<TransactionPreview {...baseProps} source="1inch" />)
    expect(screen.queryByText(/^gasless$/i)).not.toBeInTheDocument()
  })

  it("renders 'Validated selector' chip when the decoder reports validated=true", () => {
    mockDecoded.validated = true
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByText(/validated selector/i)).toBeInTheDocument()
  })

  it("renders the validation warning text when the decoder reports validated=false", () => {
    mockDecoded.validated = false
    mockDecoded.validationReason = 'Selector not in allowlist'
    render(<TransactionPreview {...baseProps} />)
    expect(screen.getByText(/selector not in allowlist/i)).toBeInTheDocument()
  })

  it('fires onConfirm when "Confirm & Sign" is clicked', () => {
    const onConfirm = vi.fn()
    render(<TransactionPreview {...baseProps} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: /confirm & sign/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when "Cancel" is clicked', () => {
    const onCancel = vi.fn()
    render(<TransactionPreview {...baseProps} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the backdrop is clicked', () => {
    const onCancel = vi.fn()
    const { container } = render(<TransactionPreview {...baseProps} onCancel={onCancel} />)
    // First child inside the dialog is the absolute-positioned backdrop.
    const backdrop = container.querySelector('.absolute.inset-0') as HTMLElement
    expect(backdrop).toBeTruthy()
    fireEvent.click(backdrop)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
