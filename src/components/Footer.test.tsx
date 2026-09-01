// @vitest-environment jsdom
/**
 * [FIX-FOOTER-BLOCKNUMBER-POLL] Footer.tsx's decorative block-number display called
 * useBlockNumber({ watch: true }) with no pollingInterval, silently inheriting wagmi/viem's
 * ~4s default — 3 eth_blockNumber calls per ~12s mainnet block, tripling Alchemy CU spend for
 * a number nobody needs live to the second. This pins an explicit, block-time-safe interval.
 */

import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'

const useBlockNumberMock = vi.fn((_args?: unknown) => ({ data: 12345678n }))

vi.mock('wagmi', () => ({
  useBlockNumber: (args?: unknown) => useBlockNumberMock(args),
}))

import Footer, { FOOTER_BLOCK_POLL_MS } from './Footer'

describe('Footer block-number polling', () => {
  it('passes an explicit pollingInterval no faster than mainnet block time (~12s)', () => {
    render(<Footer />)

    expect(useBlockNumberMock).toHaveBeenCalledWith(
      expect.objectContaining({
        watch: expect.objectContaining({ pollingInterval: expect.any(Number) }),
      })
    )

    const { watch } = useBlockNumberMock.mock.calls[0][0] as { watch: { pollingInterval: number } }
    expect(watch.pollingInterval).toBeGreaterThanOrEqual(12_000)
  })

  it('pins the configured footer poll interval so a future regression is caught', () => {
    expect(FOOTER_BLOCK_POLL_MS).toBe(12_000)
  })
})
