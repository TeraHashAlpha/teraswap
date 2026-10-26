// @vitest-environment jsdom
/**
 * [ADR-025] /v2/<tab>: one generic route behind proxy.ts. Renders the shell only for the 8 tab segments and only when
 * the switch says v2.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const h = vi.hoisted(() => ({ version: 'v2' as 'v1' | 'v2' }))
vi.mock('@/ui/v2/version', () => ({ getUiVersion: async () => h.version }))
vi.mock('@/ui/v2/shell', () => ({ AppShell: ({ tab }: { tab: string }) => <div data-shell-tab={tab} /> }))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import V2TabPage from './page'

afterEach(cleanup)
const call = (tab: string) => V2TabPage({ params: Promise.resolve({ tab }) })

describe('/v2/[tab]', () => {
  it.each(['swap', 'portfolio', 'dca', 'limit', 'sltp', 'orders', 'history', 'analytics'])('%s → the shell on that tab', async (tab) => {
    h.version = 'v2'
    const { container } = render(await call(tab))
    expect(container.querySelector(`[data-shell-tab="${tab}"]`)).not.toBeNull()
  })

  it.each(['_kit', 'nope', 'Swap', 'swap/extra', ''])('%j is not a tab → notFound()', async (tab) => {
    h.version = 'v2'
    await expect(call(tab)).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('v1 (switch off) → notFound(), never the shell', async () => {
    h.version = 'v1'
    await expect(call('swap')).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
