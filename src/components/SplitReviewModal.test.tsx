// @vitest-environment jsdom
/**
 * [SPRINT-9R R1] SplitReviewModal — the aggregate "Review Split Plan" shown before any split
 * leg is signed. Verifies it renders every leg's trust surface (reusing the shared decoder),
 * scopes the confirm CTA to signable legs, surfaces skipped legs, and wires confirm/cancel.
 */
import { describe, it, expect, vi } from 'vitest'

// Mock the shared decoder (same pattern as TransactionPreview's tests) — the modal only DISPLAYS
// its result; the real gates ran in Phase A of useSplitSwap.
vi.mock('@/lib/calldata-decoder', () => ({
  decodeTransactionPreview: vi.fn(() => ({
    sourceDex: 'Uniswap V3',
    functionName: 'exactInputSingle',
    selector: '0x04e45aaf',
    recipient: '0x1111111111111111111111111111111111111111', // == USER → "Your wallet"
    recipientType: 'extracted',
    validated: true,
  })),
}))

import { renderWithProviders, fireEvent, screen } from '@/test-utils/render'
import SplitReviewModal from './SplitReviewModal'
import type { Token } from '@/lib/tokens'
import type { PlannedLeg } from '@/hooks/useSplitSwap'

const WETH: Token = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoURI: '', category: 'Native' }
const USDC: Token = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoURI: '', category: 'Stablecoin' }
const USER = '0x1111111111111111111111111111111111111111'

function leg(over: Partial<PlannedLeg> = {}): PlannedLeg {
  return {
    source: 'uniswapv3', percent: 60, legAmount: 600000000000000000n,
    routeViaFeeCollector: true, isNativeIn: false,
    routerAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
    routerCalldata: '0x04e45aaf' + '0'.repeat(128),
    txTo: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459', txData: '0xabc', txValue: 0n, txGas: undefined,
    legMinOutput: 1_750_000_000n, expectedOut: '1800000000', outputAmount: '1800000000',
    simulated: true, status: 'reviewed',
    ...over,
  }
}

describe('SplitReviewModal [SPRINT-9R R1]', () => {
  it('lists every leg with its trust surface; CTA is scoped to signable legs', () => {
    const onConfirm = vi.fn()
    const plannedLegs: PlannedLeg[] = [
      leg({ percent: 60 }),
      leg({ source: 'kyberswap', percent: 40 }),
      leg({ source: 'velora', percent: 0, status: 'skipped', error: 'Simulation reverted', txTo: undefined, txData: undefined }),
    ]
    renderWithProviders(
      <SplitReviewModal plannedLegs={plannedLegs} tokenIn={WETH} tokenOut={USDC} userAddress={USER} onConfirm={onConfirm} onCancel={vi.fn()} />,
    )
    // All three legs render.
    expect(screen.getByTestId('split-leg-0')).toBeInTheDocument()
    expect(screen.getByTestId('split-leg-1')).toBeInTheDocument()
    expect(screen.getByTestId('split-leg-2')).toBeInTheDocument()
    // Skipped leg is surfaced (won't be signed).
    expect(screen.getByTestId('split-leg-2').textContent).toMatch(/skipped/i)
    // Trust surface on a reviewed leg: recipient resolves to the user's wallet + validated selector.
    expect(screen.getByTestId('split-leg-0').textContent).toMatch(/your wallet/i)
    expect(screen.getByTestId('split-leg-0').textContent).toMatch(/validated selector/i)
    // The confirm CTA reflects only the 2 reviewed (signable) legs.
    const confirmBtn = screen.getByRole('button', { name: /confirm & sign 2 legs/i })
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('Cancel triggers onCancel', () => {
    const onCancel = vi.fn()
    renderWithProviders(
      <SplitReviewModal plannedLegs={[leg()]} tokenIn={WETH} tokenOut={USDC} userAddress={USER} onConfirm={vi.fn()} onCancel={onCancel} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables the confirm CTA when no leg is signable', () => {
    const plannedLegs: PlannedLeg[] = [
      leg({ status: 'skipped', error: 'all failed', txTo: undefined, txData: undefined }),
    ]
    renderWithProviders(
      <SplitReviewModal plannedLegs={plannedLegs} tokenIn={WETH} tokenOut={USDC} userAddress={USER} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(screen.getByRole('button', { name: /confirm & sign 0 legs/i })).toBeDisabled()
  })
})
