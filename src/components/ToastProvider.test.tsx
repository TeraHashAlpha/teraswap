// @vitest-environment jsdom
/**
 * [fix/tx-links-remaining] ToastProvider's tx-hash link used to be mainnet-only (`ETHERSCAN_TX`) —
 * a Base/Arbitrum tx linked to etherscan.io, where it doesn't exist. It now carries an optional
 * `chainId` on the `Toast` (the caller's SEND-site chain, e.g. useSwap's `txChainId`) and renders
 * via the chain-aware `explorerTxUrl`, falling back to mainnet (1) only when a caller genuinely
 * supplies none — never from the wallet's live/current chain, which this file has no access to at
 * all (the toast only knows what the caller passed it, which is the whole point of the fix).
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ToastProvider, useToast } from './ToastProvider'

function Trigger({ txHash, chainId }: { txHash: string; chainId?: number }) {
  const { toast } = useToast()
  return (
    <button onClick={() => toast({ type: 'success', title: 'Done', txHash, chainId, duration: 0 })}>
      fire
    </button>
  )
}

function renderTrigger(props: { txHash: string; chainId?: number }) {
  render(
    <ToastProvider>
      <Trigger {...props} />
    </ToastProvider>,
  )
}

describe('ToastProvider — [fix/tx-links-remaining] chain-aware explorer link', () => {
  it.each([
    [1, 'etherscan.io'],
    [8453, 'basescan.org'],
    [42161, 'arbiscan.io'],
  ])('a toast with chainId %i links to %s', async (chainId, host) => {
    renderTrigger({ txHash: '0xabc', chainId })
    await act(async () => { fireEvent.click(screen.getByText('fire')) })
    const link = screen.getByText('View on explorer').closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe(host)
  })

  it('a toast with NO chainId falls back to mainnet (1) — never guesses, just the documented default', async () => {
    renderTrigger({ txHash: '0xabc' })
    await act(async () => { fireEvent.click(screen.getByText('fire')) })
    const link = screen.getByText('View on explorer').closest('a') as HTMLAnchorElement
    expect(new URL(link.href).hostname).toBe('etherscan.io')
  })

  it('a toast with no txHash renders no explorer link at all', async () => {
    render(
      <ToastProvider>
        <ToastNoHashTrigger />
      </ToastProvider>,
    )
    await act(async () => { fireEvent.click(screen.getByText('fire')) })
    expect(screen.queryByText('View on explorer')).toBeNull()
  })
})

function ToastNoHashTrigger() {
  const { toast } = useToast()
  return <button onClick={() => toast({ type: 'info', title: 'No tx here', duration: 0 })}>fire</button>
}
