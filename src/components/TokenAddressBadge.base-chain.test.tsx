// @vitest-environment jsdom
/**
 * [fix/stale-quote-pair-flip] TokenAddressBadge verifies against the QUOTE chain.
 *
 * Real chain hooks + real catalog (no mocks of useChainId / isVerifiedToken): a DISCONNECTED
 * visitor who picked Base in ChainSelector must see Base USDC as verified. The badge used to
 * resolve its chain with useActiveChainId() (wallet chain ?? mainnet), looked Base USDC up in
 * chain 1's catalog and showed the amber "Imported token" warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chain: undefined }),
}))

import TokenAddressBadge from './TokenAddressBadge'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`

beforeEach(() => {
  cleanup()
  useDisconnectedChainSelection.setState({ chainId: null })
})
afterEach(() => useDisconnectedChainSelection.setState({ chainId: null }))

describe('TokenAddressBadge — chain comes from the quote path, not the wallet fallback', () => {
  it('Base USDC, NO wallet, Base picked in ChainSelector → verified shield, no amber ⚠', () => {
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    const { container } = render(<TokenAddressBadge address={BASE_USDC} />)
    expect(container.querySelector('span[title^="Verified"]')).not.toBeNull()
    expect(container.querySelector('span[title^="Imported token"]')).toBeNull()
  })

  it('control: Base USDC with no chain picked (mainnet) is NOT in the mainnet catalog → amber, so the chain really is what decides', () => {
    const { container } = render(<TokenAddressBadge address={BASE_USDC} />)
    expect(container.querySelector('span[title^="Imported token"]')).not.toBeNull()
  })

  it('mainnet USDC, no wallet, no chain picked → still verified (mainnet behaviour unchanged)', () => {
    const { container } = render(<TokenAddressBadge address={MAINNET_USDC} />)
    expect(container.querySelector('span[title^="Verified"]')).not.toBeNull()
  })

  it('an explicit chainId prop still overrides the hook', () => {
    useDisconnectedChainSelection.setState({ chainId: 1 })
    const { container } = render(<TokenAddressBadge address={BASE_USDC} chainId={8453} />)
    expect(container.querySelector('span[title^="Verified"]')).not.toBeNull()
  })
})
