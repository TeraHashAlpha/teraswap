// @vitest-environment jsdom
/**
 * [L-1, owner decision: BUILD in v2] v1's SwapHistory (src/components/SwapHistory.tsx), same data (the shared
 * useSwapHistory zustand store) and v1's copy verbatim, drawn in the no-box language (a hairline, not a rounded
 * bg-surface-secondary box).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSwapHistory, type SwapRecord } from '@/hooks/useSwapHistory'
import { RecentSwaps } from './RecentSwaps'

const record = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  id: 'r1',
  date: '2026-11-05',
  tokenIn: 'ETH',
  tokenOut: 'USDC',
  amountIn: '1',
  amountOut: '2487.6842',
  txHash: '0x8c1f000000000000000000000000000000000000000000000000000000c44b0',
  status: 'confirmed' as const,
  chainId: 1,
  ...over,
})

beforeEach(() => {
  useSwapHistory.setState({ records: [] })
})
afterEach(cleanup)

describe('RecentSwaps', () => {
  it('no records: renders nothing, as v1', () => {
    render(<RecentSwaps />)
    expect(document.body.textContent).toBe('')
  })

  it('v1\'s collapsed header, same count; expands on click to v1\'s row text and an Explorer link to the record\'s chain', () => {
    useSwapHistory.setState({ records: [record()] })
    render(<RecentSwaps />)
    expect(screen.getByText('Recent swaps (1)')).toBeTruthy()
    expect(screen.queryByText('Explorer')).toBeNull()
    fireEvent.click(screen.getByText('Recent swaps (1)'))
    expect(screen.getByText('1.0000 ETH → 2 487.6842 USDC')).toBeTruthy()
    const link = screen.getByText('Explorer').closest('a') as HTMLAnchorElement
    expect(link.href).toBe('https://etherscan.io/tx/0x8c1f000000000000000000000000000000000000000000000000000000c44b0')
    expect(link.target).toBe('_blank')
  })

  it('no box: no rounded/bordered container class on the root — a hairline Surface only', () => {
    useSwapHistory.setState({ records: [record()] })
    render(<RecentSwaps />)
    const root = screen.getByText('Recent swaps (1)').closest('[data-surface]') as HTMLElement
    expect(root).toBeTruthy()
    expect(root.className).not.toMatch(/rounded|border|bg-surface/)
  })
})
