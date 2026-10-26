// @vitest-environment jsdom
/**
 * [ADR-025] App shell (pack 01/03/04/05): header, network dropdown, tabs, DCA gate, footer, help drawer, fabs.
 * wagmi / RainbowKit / next are mocked at the module edge; everything under test is the real v2 shell + the real
 * v1 helpers it reuses (useQuoteChainId, registry, help-content, product-claims).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  isConnected: false,
  walletChainId: undefined as number | undefined,
  push: vi.fn(),
  switchChain: vi.fn(),
  pathname: '/swap',
  block: 23_541_870n as bigint | undefined,
  blockCalls: [] as unknown[],
  dcaLive: new Set<number>([8453]),
  limitLive: false,
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected, chain: h.walletChainId ? { id: h.walletChainId } : undefined }),
  useSwitchChain: () => ({ switchChain: h.switchChain, isPending: false }),
  useBlockNumber: (args: unknown) => {
    h.blockCalls.push(args)
    return { data: h.block }
  },
  useBalance: () => ({ data: undefined }),
  useEnsName: () => ({ data: undefined }),
  useEnsAvatar: () => ({ data: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}))
vi.mock('wagmi/chains', () => ({ mainnet: { id: 1 } }))
vi.mock('@rainbow-me/rainbowkit', async () => {
  const actual = await vi.importActual<typeof import('@rainbow-me/rainbowkit')>('@rainbow-me/rainbowkit')
  return {
    darkTheme: actual.darkTheme,
    RainbowKitProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ConnectButton: {
      Custom: ({ children }: { children: (p: unknown) => React.ReactNode }) =>
        children({ account: undefined, chain: undefined, openConnectModal: vi.fn(), mounted: true }),
    },
  }
})
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: h.push }) }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars' }))
// Base / Arbitrum FeeCollectors are env-driven (unset under test) → every chain would be "coming soon".
// Only that gate is overridden, as in v1's ChainSelector test.
vi.mock('@/lib/chains/registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains/registry')>('@/lib/chains/registry')
  return {
    ...actual,
    getChainConfig: (id: number) => {
      const cfg = actual.getChainConfig(id)
      return { ...cfg, contracts: { ...cfg.contracts, feeCollector: cfg.contracts.feeCollector ?? ('0x1111111111111111111111111111111111111111' as const) } }
    },
  }
})
vi.mock('@/lib/dca-launch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dca-launch')>('@/lib/dca-launch')
  return { ...actual, isDcaLive: (id: number) => h.dcaLive.has(id) }
})
vi.mock('@/lib/order-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/order-engine')>('@/lib/order-engine')
  return { ...actual, isLimitLive: () => h.limitLive }
})

import { FOOTER_RISK_LINE } from '@/components/Footer'
import { COPYRIGHT_YEAR, PLATFORM_FEE_LABEL } from '@/config/product-claims'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'
import { helpSections } from '@/lib/help-content'
import { SUPPORT_EMAIL } from '@/lib/constants'
import { AppShell } from './AppShell'
import { V2_RISK_LINE } from './Footer'
import { shellChains } from './chains'

beforeEach(() => {
  h.isConnected = false
  h.walletChainId = undefined
  h.pathname = '/swap'
  h.block = 23_541_870n
  h.blockCalls = []
  h.dcaLive = new Set([8453])
  h.limitLive = false
  h.push.mockClear()
  h.switchChain.mockClear()
  useDisconnectedChainSelection.setState({ chainId: null })
})
afterEach(cleanup)

describe('header', () => {
  it('has the logo (no BETA), no search field, no theme toggle', () => {
    render(<AppShell />)
    const header = screen.getByRole('banner')
    expect(within(header).getByText('TeraSwap')).toBeTruthy()
    expect(header.textContent ?? '').not.toMatch(/beta/i)
    expect(header.querySelector('input')).toBeNull()
    expect(within(header).queryByRole('button', { name: /theme|dark|light/i })).toBeNull()
  })

  it('has Connect when disconnected', () => {
    render(<AppShell />)
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /connect/i })).toBeTruthy()
  })
})

describe('network dropdown', () => {
  function openMenu() {
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: /^Network:/ }))
    return screen.getByRole('listbox', { name: 'Networks' })
  }

  it('lists exactly the 3 registry networks, no search field', () => {
    const list = openMenu()
    expect(within(list).getAllByRole('option')).toHaveLength(3)
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Ethereum'),
      expect.stringContaining('Base'),
      expect.stringContaining('Arbitrum One'),
    ])
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull()
  })

  it('subtitles come from isDcaLive: Ethereum "Swap", Base "Swap · DCA", Arbitrum "Swap" until its executor is live', () => {
    expect(shellChains().map((c) => [c.name, c.subtitle])).toEqual([
      ['Ethereum', 'Swap'],
      ['Base', 'Swap · DCA'],
      ['Arbitrum One', 'Swap'],
    ])
    h.dcaLive = new Set([8453, 42161])
    expect(shellChains().map((c) => c.subtitle)).toEqual(['Swap', 'Swap · DCA', 'Swap · DCA'])
  })

  it('marks the selected network; disconnected selection goes through the shared store (v1 semantics)', () => {
    const list = openMenu()
    expect(within(list).getByRole('option', { name: /Ethereum/ }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(within(list).getByRole('option', { name: /Base/ }))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(8453)
    expect(h.switchChain).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('connected selection calls wagmi switchChain; Escape closes', () => {
    h.isConnected = true
    h.walletChainId = 1
    const list = openMenu()
    fireEvent.click(within(list).getByRole('option', { name: /Arbitrum One/ }))
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: 42161 })
    fireEvent.click(screen.getByRole('button', { name: /^Network:/ }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('tabs', () => {
  it('renders the 8 tabs; "Soon" only on Limit and SL/TP; DCA never "Soon"', () => {
    for (const chain of [1, 8453, 42161]) {
      cleanup()
      useDisconnectedChainSelection.setState({ chainId: chain })
      render(<AppShell />)
      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((t) => t.textContent)).toEqual([
        'Swap', 'Portfolio', 'DCA', 'LimitSoon', 'SL/TPSoon', 'Orders', 'History', 'Analytics',
      ])
      expect(screen.getByRole('tab', { name: 'DCA' }).textContent).not.toMatch(/soon/i)
    }
  })

  it('Limit / SL/TP lose "Soon" when v1\'s isLimitLive gate says live', () => {
    h.limitLive = true
    render(<AppShell />)
    expect(screen.getByRole('tab', { name: 'Limit' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Soon')).toBeNull()
  })

  it('the tab in the URL is active; clicking another navigates to its path', () => {
    h.pathname = '/v2/orders'
    render(<AppShell />)
    expect(screen.getByRole('tab', { name: 'Orders' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Portfolio' }))
    expect(h.push).toHaveBeenCalledWith('/portfolio')
  })
})

describe('DCA tab', () => {
  it('Ethereum: "DCA runs on …" + switch buttons for the LIVE chains only (Arbitrum dark today)', () => {
    h.pathname = '/dca'
    render(<AppShell />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DCA runs on Base.')
    expect(screen.getByRole('button', { name: 'Switch to Base' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Switch to Arbitrum One/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Base' }))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(8453)
  })

  it('both live → the spec text "DCA runs on Base and Arbitrum One." with both switches', () => {
    h.pathname = '/dca'
    h.dcaLive = new Set([8453, 42161])
    render(<AppShell />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DCA runs on Base and Arbitrum One.')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Arbitrum One' }))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(42161)
  })

  it('on a DCA chain, or when nothing is live, the plain pane shows — no claim, never "Soon"', () => {
    h.pathname = '/dca'
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    render(<AppShell />)
    expect(document.querySelector('[data-dca-gate]')).toBeNull()
    expect(document.querySelector('[data-tab-pane="dca"]')).not.toBeNull()
    cleanup()
    useDisconnectedChainSelection.setState({ chainId: null })
    h.dcaLive = new Set()
    render(<AppShell />)
    expect(document.querySelector('[data-dca-gate]')).toBeNull()
    expect(screen.queryByText(/DCA runs on/)).toBeNull()
    expect(document.querySelector('[data-tab-pane="dca"]')?.textContent).not.toMatch(/soon/i)
    expect(screen.getByRole('tab', { name: 'DCA' }).textContent).not.toMatch(/soon/i)
  })
})

describe('panes', () => {
  it.each(['swap', 'portfolio', 'dca', 'limit', 'sltp', 'orders', 'history', 'analytics'] as const)('%s is a Skeleton placeholder', (tab) => {
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    render(<AppShell tab={tab} />)
    const pane = document.querySelector(`[data-tab-pane="${tab}"]`)
    expect(pane).not.toBeNull()
    expect(pane?.querySelectorAll('.ts-v2-skeleton').length).toBeGreaterThan(0)
    expect(pane?.textContent).toBe('')
  })
})

describe('footer', () => {
  it('carries every v1 footer item', () => {
    render(<AppShell />)
    const footer = screen.getByRole('contentinfo')
    const f = within(footer)
    expect(f.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/docs')
    expect(f.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('https://github.com/TeraHashAlpha/teraswap')
    expect(f.getByRole('link', { name: 'X (Twitter)' }).getAttribute('href')).toBe('https://x.com/TeraHash')
    expect(footer.textContent).toContain(`Fee ${PLATFORM_FEE_LABEL}`)
    expect(footer.textContent).toContain('No infinite approvals')
    expect(f.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy')
    expect(f.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('/terms')
    expect(f.getByRole('link', { name: `Email support at ${SUPPORT_EMAIL}` }).getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}`)
    expect(footer.textContent).toContain(`© ${COPYRIGHT_YEAR} TeraSwap`)
    expect(f.getByRole('link', { name: 'TeraHelps' }).getAttribute('href')).toBe('https://terahelps.netlify.app/')
  })

  it('risk line is verbatim and identical to v1\'s', () => {
    render(<AppShell />)
    const literal = 'Smart contracts have not been externally audited. Use at your own risk.'
    expect(V2_RISK_LINE).toBe(literal)
    expect(FOOTER_RISK_LINE).toBe(literal)
    expect(within(screen.getByRole('contentinfo')).getByText(literal)).toBeTruthy()
  })

  it.each([
    [1, 'Ethereum', 'https://etherscan.io'],
    [8453, 'Base', 'https://basescan.org'],
    [42161, 'Arbitrum One', 'https://arbiscan.io'],
  ])('block line follows the SELECTED chain %i (disconnected pick) and links to its explorer', (chainId, name, explorer) => {
    useDisconnectedChainSelection.setState({ chainId })
    render(<AppShell />)
    const link = within(screen.getByRole('contentinfo')).getByRole('link', { name: `${name} · Block #23\u2009541\u2009870` })
    expect(link.getAttribute('href')).toBe(`${explorer}/block/23541870`)
    expect(h.blockCalls.at(-1)).toMatchObject({ chainId, query: { refetchInterval: 12_000, refetchIntervalInBackground: false } })
  })

  it('a connected wallet\'s chain wins over a stale disconnected pick', () => {
    useDisconnectedChainSelection.setState({ chainId: 1 })
    h.isConnected = true
    h.walletChainId = 42161
    render(<AppShell />)
    expect(h.blockCalls.at(-1)).toMatchObject({ chainId: 42161 })
    expect(screen.getByRole('link', { name: /Arbitrum One · Block/ })).toBeTruthy()
  })

  it('no block item before the first block arrives', () => {
    h.block = undefined
    render(<AppShell />)
    expect(screen.getByRole('contentinfo').textContent).not.toMatch(/Block #/)
  })
})

describe('help drawer + fabs', () => {
  it('? opens the drawer with v1\'s help sections; Esc, ✕ and the overlay close it', () => {
    render(<AppShell />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }))
    const dialog = screen.getByRole('dialog')
    for (const s of helpSections) expect(within(dialog).getByRole('button', { name: new RegExp(s.title.replace(/[()/]/g, '\\$&')) })).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Email support' }).getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}`)
    expect(within(dialog).getByRole('link', { name: '@TeraHash on X' }).getAttribute('href')).toBe('https://x.com/TeraHash')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close help' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }))
    fireEvent.click(document.querySelector('[aria-hidden="true"].fixed.inset-0') as HTMLElement)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('search filters the sections, and an answer expands on click', () => {
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }))
    const first = helpSections[0].items[0]
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search help' }), { target: { value: first.q.toLowerCase() } })
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: first.q }))
    expect(within(dialog).getByText(first.a)).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search help' }), { target: { value: 'zzzz-no-match' } })
    expect(within(dialog).queryByText(first.q)).toBeNull()
  })

  it('♫ is a toggle button (on by default, ♫ ↔ ✕)', async () => {
    const sounds = await import('@/lib/sounds')
    const spy = vi.spyOn(sounds, 'toggleBackgroundMusic').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<AppShell />)
    const btn = screen.getByRole('button', { name: 'Turn music off' })
    expect(btn.textContent).toBe('♫')
    await act(async () => void fireEvent.click(btn))
    expect(screen.getByRole('button', { name: 'Turn music on' }).textContent).toBe('✕')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Turn music on' })))
    expect(screen.getByRole('button', { name: 'Turn music off' }).textContent).toBe('♫')
    spy.mockRestore()
  })
})
