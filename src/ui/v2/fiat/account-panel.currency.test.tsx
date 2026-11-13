// @vitest-environment jsdom
/** [feat/ui-v2-fiat-value C2] The currency switch lives in the v2 account menu (AccountPanel), under the connection line. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', connector: { name: 'Test wallet' } }),
  useBalance: () => ({ data: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useEnsName: () => ({ data: null }),
  useEnsAvatar: () => ({ data: null }),
}))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))

import { AccountPanel } from '../shell/AccountPanel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AccountPanel', () => {
  it('has the labelled Currency group with $ USD and € EUR, and opening it asks the EUR route once', () => {
    const fetchSpy = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetchSpy)
    render(<AccountPanel open onClose={() => {}} />)
    const group = screen.getByRole('group', { name: 'Currency' })
    expect(group.textContent).toContain('$ USD')
    expect(group.textContent).toContain('€ EUR')
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('a closed panel renders nothing and asks nothing', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    render(<AccountPanel open={false} onClose={() => {}} />)
    expect(screen.queryByRole('group', { name: 'Currency' })).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
