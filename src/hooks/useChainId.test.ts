// @vitest-environment jsdom
/**
 * [feat/quote-before-wallet] useChainId — pins:
 *
 *   - useActiveChainId's existing wallet-derived fallback is UNCHANGED
 *     (still assumes mainnet while disconnected; ~15 non-quote consumers
 *     depend on that).
 *   - useQuoteChainId (new): identical to useActiveChainId while connected,
 *     but while disconnected it follows whatever chain the visitor picked
 *     in ChainSelector (useDisconnectedChainSelection) instead of assuming
 *     mainnet — this is what lets "change the network selector without a
 *     wallet" actually change the quote's chain (goal acceptance #2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

let mockIsConnected = true
let mockChainId: number | undefined = 1
vi.mock('wagmi', () => ({
  useAccount: vi.fn(() => ({
    isConnected: mockIsConnected,
    chain: mockIsConnected ? { id: mockChainId, name: 'chain' } : undefined,
  })),
}))

import { useActiveChainId, useQuoteChainId, useDisconnectedChainSelection } from './useChainId'

beforeEach(() => {
  mockIsConnected = true
  mockChainId = 1
  useDisconnectedChainSelection.setState({ chainId: null })
})

describe('useActiveChainId — unchanged wallet-derived fallback', () => {
  it('returns the wallet chain when connected', () => {
    mockChainId = 8453
    const { result } = renderHook(() => useActiveChainId())
    expect(result.current).toBe(8453)
  })

  it('falls back to mainnet (1) when disconnected, regardless of any ChainSelector pick', () => {
    mockIsConnected = false
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    const { result } = renderHook(() => useActiveChainId())
    expect(result.current).toBe(1)
  })
})

describe('useQuoteChainId — quote/browse path only', () => {
  it('matches the wallet chain when connected (same as useActiveChainId)', () => {
    mockChainId = 8453
    const { result } = renderHook(() => useQuoteChainId())
    expect(result.current).toBe(8453)
  })

  it('falls back to mainnet (1) when disconnected and no chain has been picked', () => {
    mockIsConnected = false
    const { result } = renderHook(() => useQuoteChainId())
    expect(result.current).toBe(1)
  })

  it('follows the ChainSelector pick when disconnected [acceptance 2]', () => {
    mockIsConnected = false
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    const { result } = renderHook(() => useQuoteChainId())
    expect(result.current).toBe(8453)
  })

  it('ignores a stale disconnected pick once a wallet connects', () => {
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    mockIsConnected = true
    mockChainId = 1
    const { result } = renderHook(() => useQuoteChainId())
    expect(result.current).toBe(1)
  })
})
