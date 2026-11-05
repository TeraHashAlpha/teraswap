// @vitest-environment jsdom
/**
 * [ADR-025] App shell (pack 01/03/04/05): header, network dropdown, tabs, DCA gate, footer, help drawer, fabs.
 * wagmi / RainbowKit / next are mocked at the module edge; everything under test is the real v2 shell + the real
 * v1 helpers it reuses (useQuoteChainId, registry, help-content, product-claims).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  crashSwap: false,
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
// B3: these tests are about the shell, not the Swap card (its own tests mock the hooks it reads): the Swap tab pane is a placeholder here.
vi.mock('../swap/SwapCard', () => ({
  SwapCard: () => {
    if (h.crashSwap) throw new Error('boom')
    return <section data-tab-pane="swap" aria-busy="true" />
  },
}))
// B6a: likewise the DCA form (its own tests mock the hooks it reads): on a live DCA chain the pane is a placeholder here.
vi.mock('../dca/DcaCard', () => ({ DcaCard: () => <section data-tab-pane="dca" aria-busy="true" /> }))
// B7: likewise the Orders tab (its own tests run it on v1's engine contract): here the pane is a stub.
vi.mock('../orders/OrdersTab', () => ({ OrdersTab: () => <section data-tab-pane="orders" aria-busy="true" /> }))
vi.mock('../history/HistoryTab', () => ({ HistoryTab: () => <section data-tab-pane="history" aria-busy="true" /> }))
// B8: likewise the Portfolio tab (its own tests run it on v1's usePortfolio contract): here the pane is a stub.
vi.mock('../portfolio/PortfolioTab', () => ({ PortfolioTab: () => <section data-tab-pane="portfolio" aria-busy="true" /> }))
// B9: likewise the Analytics tab (its own tests run it on v1's three reads): here the pane is a stub.
vi.mock('../analytics/AnalyticsTab', () => ({ AnalyticsTab: () => <section data-tab-pane="analytics" aria-busy="true" /> }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
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
import { useSwapHistory } from '@/hooks/useSwapHistory'
import { helpSections } from '@/lib/help-content'
import { SUPPORT_EMAIL } from '@/lib/constants'
import { AppShell } from './AppShell'
import { resetMusicStateForTests } from './music'

/** Which speaker the ♫ button shows (round-6 icons replaced the ♫ / ✕ glyphs). */
const icon = (btn: HTMLElement) => btn.querySelector('svg[data-music-icon]')?.getAttribute('data-music-icon')
import { V2_RISK_LINE } from './Footer'
import { escapeRegExp } from '@/test-utils/escape-regexp'
import { NETWORK_SUBTITLE, shellChains } from './chains'

beforeEach(() => {
  h.isConnected = false
  h.walletChainId = undefined
  h.pathname = '/swap'
  h.block = 23_541_870n
  h.blockCalls = []
  h.dcaLive = new Set([8453])
  h.limitLive = false
  process.env.NEXT_PUBLIC_DCA_ENABLED = 'true' // v1's launch flag: the gate is `flag && !DCA_CHAINS.includes(chain)`
  h.push.mockClear()
  h.crashSwap = false
  h.switchChain.mockClear()
  useDisconnectedChainSelection.setState({ chainId: null })
  resetMusicStateForTests()
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

  it('subtitle is "Change" on every network — one slot constant, independent of isDcaLive', () => {
    expect(NETWORK_SUBTITLE).toBe('Change')
    for (const live of [new Set<number>(), new Set([8453]), new Set([8453, 42161])]) {
      h.dcaLive = live
      expect(shellChains().map((c) => [c.name, c.subtitle])).toEqual([
        ['Ethereum', 'Change'],
        ['Base', 'Change'],
        ['Arbitrum One', 'Change'],
      ])
    }
  })

  it('renders "Change" under each of the 3 names and never "Swap" / "Swap · DCA"', () => {
    const list = openMenu()
    for (const name of ['Ethereum', 'Base', 'Arbitrum One']) {
      const option = within(list).getByRole('option', { name: new RegExp(name) })
      expect(option.textContent?.replace('✓', '')).toBe(`${name}Change`)
    }
    expect(list.textContent).not.toMatch(/Swap/)
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

  it('Limit / SL/TP stay disabled "Soon" even when v1\'s isLimitLive gate says live — v2 has no pane for them (owner decision)', () => {
    for (const chain of [1, 8453, 42161]) {
      cleanup()
      h.limitLive = true
      useDisconnectedChainSelection.setState({ chainId: chain })
      render(<AppShell />)
      for (const name of ['Limit', 'SL/TP']) {
        const tab = screen.getByRole('tab', { name: new RegExp(`^${name.replace('/', '\\/')}`) })
        expect(tab.hasAttribute('disabled')).toBe(true)
        expect(tab.textContent).toMatch(/soon/i)
        fireEvent.click(tab)
      }
      expect(h.push).not.toHaveBeenCalled() // the skeleton TabPane is never reachable from the strip
    }
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
  it('Ethereum: the gate names every DCA chain (v1\'s DCA_CHAINS) with a switch for each — whatever is live', () => {
    h.pathname = '/dca'
    for (const live of [new Set([8453]), new Set([8453, 42161]), new Set<number>()]) {
      h.dcaLive = live
      render(<AppShell />)
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('DCA runs on Base and Arbitrum One.')
      expect(screen.getAllByRole('button', { name: /^Switch to / }).map((b) => b.textContent)).toEqual(['Switch to Base', 'Switch to Arbitrum One'])
      cleanup()
    }
  })

  it('the switch buttons select that network', () => {
    h.pathname = '/dca'
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Base' }))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(8453)
    cleanup()
    useDisconnectedChainSelection.setState({ chainId: null })
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Arbitrum One' }))
    expect(useDisconnectedChainSelection.getState().chainId).toBe(42161)
  })

  it('on a DCA chain, the plain pane shows — no claim, never "Soon"', () => {
    h.pathname = '/dca'
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    render(<AppShell />)
    expect(document.querySelector('[data-dca-gate]')).toBeNull()
    expect(document.querySelector('[data-tab-pane="dca"]')).not.toBeNull()
  })

  // [H-1, A75] Required test: NEXT_PUBLIC_DCA_ENABLED unset. With the launch flag off, isDcaLive and
  // shouldShowDcaGate are BOTH false on every chain — the tab used to fall all the way through to the permanent
  // empty skeleton. It must show v1's ComingSoonPanel instead; the tab STRIP's own label still never says "Soon"
  // (unaffected — that is the DCA tab's own, deliberate difference from Limit/SL-TP, pinned in 'tabs' above).
  it('with the launch flag unset, v1\'s ComingSoonPanel shows on a DCA chain — never the skeleton, never a bare unclaimed pane', () => {
    h.pathname = '/dca'
    h.dcaLive = new Set() // the real isDcaLive would also say false for every chain once the flag is off
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    delete process.env.NEXT_PUBLIC_DCA_ENABLED
    render(<AppShell />)
    expect(document.querySelector('[data-dca-gate]')).toBeNull()
    expect(document.querySelector('.ts-v2-skeleton')).toBeNull()
    expect(screen.getByText('Smart DCA Engine')).toBeTruthy()
    expect(screen.getByText('Coming Soon')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Swap Now/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'DCA' }).textContent).not.toMatch(/soon/i)
  })
})

describe('DCA tab · per selected network (the gate, never the skeleton, when DCA runs elsewhere)', () => {
  const NAMES: Record<number, string> = { 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum One' }

  // [selected chain, heading or null (= the DCA pane, no gate), switch buttons]
  const CASES: Array<[number, string | null, string[]]> = [
    [1, 'DCA runs on Base and Arbitrum One.', ['Switch to Base', 'Switch to Arbitrum One']],
    // Both are in DCA_CHAINS: the gate is about the NETWORK not being a DCA network, so it never shows there.
    [8453, null, []],
    [42161, null, []],
  ]

  it.each(CASES)('chain %i → %j', (chainId, heading, buttons) => {
    h.pathname = '/dca'
    useDisconnectedChainSelection.setState({ chainId })
    render(<AppShell />)
    const pane = document.querySelector('[data-tab-pane="dca"]')!
    expect(pane).not.toBeNull()
    if (heading === null) {
      expect(document.querySelector('[data-dca-gate]')).toBeNull()
      expect(screen.queryByText(/DCA runs on/)).toBeNull()
      return
    }
    expect(document.querySelector('[data-dca-gate]')).not.toBeNull()
    expect(pane.hasAttribute('aria-busy')).toBe(false)
    expect(pane.querySelector('.ts-v2-skeleton')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(heading)
    expect(screen.getByText(`${NAMES[chainId]} is selected. Switch network to create or manage DCA positions.`)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Switch to / }).map((b) => b.textContent)).toEqual(buttons)
  })

  // [H-1, A75] Arbitrum is in DCA_CHAINS (the allowlist) but, per docs/DEPLOYMENTS.md, OrderExecutorV3 is not yet
  // operational there — the network is neither "wrong" (so the gate never shows, confirmed above) nor live, so
  // v1's ComingSoonPanel must carry the tab, never the permanent skeleton.
  it('chain 42161: neither the gate nor the live card — v1\'s ComingSoonPanel, never the skeleton', () => {
    h.pathname = '/dca'
    h.dcaLive = new Set([8453]) // Arbitrum's v3 executor is not wired (real isDcaLive would also say false)
    useDisconnectedChainSelection.setState({ chainId: 42161 })
    render(<AppShell />)
    expect(document.querySelector('[data-dca-gate]')).toBeNull()
    expect(document.querySelector('.ts-v2-skeleton')).toBeNull()
    expect(screen.getByText('Smart DCA Engine')).toBeTruthy()
    expect(screen.getByText('Coming Soon')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Swap Now/ })).toBeTruthy()
  })

  it('connected on Ethereum: the buttons call wagmi switchChain', () => {
    h.pathname = '/dca'
    h.isConnected = true
    h.walletChainId = 1
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Base' }))
    expect(h.switchChain).toHaveBeenCalledWith({ chainId: 8453 })
  })
})

describe('photo credit placement (owner review 26 Oct: never over the floating ? / ♫)', () => {
  const PHOTO_CSS = readFileSync(join(__dirname, '..', 'photos', 'photo.css'), 'utf8')

  it('the credit is inside the footer container; the fabs and the photo layer are distinct containers', () => {
    render(<AppShell tab="swap" />)
    const footer = document.querySelector('[data-ts-footer]')!
    const credit = screen.getByText('Photo Phil Evenden / Pexels')
    expect(footer.contains(credit)).toBe(true)
    const fabs = [screen.getByRole('button', { name: /music/i }), screen.getByRole('button', { name: 'Open help' })]
    for (const fab of fabs) {
      expect(footer.contains(fab)).toBe(false)
      expect(fab.contains(credit) || credit.contains(fab)).toBe(false)
    }
    expect(document.querySelector('.ts-v2-photo')!.contains(credit)).toBe(false)
  })

  it('left-aligned, in flow: the credit CSS has no fixed/absolute positioning and no right offset', () => {
    const rule = PHOTO_CSS.match(/\.ts-v2-photo-credit \{[^}]*\}/)![0]
    expect(rule).not.toMatch(/position:\s*(fixed|absolute)/)
    expect(rule).not.toMatch(/\bright:|\bbottom:/)
  })

  it('the fabs are the only fixed corner elements (viewport corners), the credit is not one of them', () => {
    render(<AppShell tab="swap" />)
    const fixed = Array.from(document.querySelectorAll('button')).filter((b) => /\bfixed\b/.test(b.className))
    expect(fixed).toHaveLength(2)
    expect(/\bfixed\b/.test(screen.getByText('Photo Phil Evenden / Pexels').className)).toBe(false)
  })

  it('under 640 px the fabs sit at the bottom edge (the footer reserves that space), from sm up above the photo band', () => {
    render(<AppShell tab="swap" />)
    for (const fab of [screen.getByRole('button', { name: /music/i }), screen.getByRole('button', { name: 'Open help' })]) {
      expect(fab.className).toContain('bottom-3')
      expect(fab.className).toContain('sm:bottom-[calc(var(--photo-footer-band)+12px)]')
    }
    // the footer's own bottom padding is what keeps the credit / links clear of them
    expect(document.querySelector('[data-ts-footer]')!.className).toContain('pb-20')
  })

  it.each([
    ['swap', 'Phil Evenden'],
    ['portfolio', 'Владимир Николаевич'],
    ['dca', 'Willbone Gallery'],
    ['limit', 'Oleksiy Yeshtokyn'],
    ['sltp', 'wal_ 172619'],
    ['orders', 'Peter Dyllong'],
    ['history', 'Erik Mclean'],
    ['analytics', 'MAG Photography'],
  ] as const)('%s → credit names the photographer of that tab\'s photo', (tab, who) => {
    render(<AppShell tab={tab} />)
    expect(screen.getByText(`Photo ${who} / Pexels`)).toBeTruthy()
  })
})

describe('panes', () => {
  it('swap mounts the Swap card (B3), not the placeholder', () => {
    render(<AppShell tab="swap" />)
    const pane = document.querySelector('[data-tab-pane="swap"]')
    expect(pane).not.toBeNull() // the stubbed card above; the real one is tested in swap/
    expect(pane?.querySelectorAll('.ts-v2-skeleton').length).toBe(0)
  })

  // [L-1, owner decision: BUILD in v2] v1's SwapHistory sits below SwapBox on the Swap tab (page.tsx); v2's
  // RecentSwaps is its sibling here, below the Swap card — not v1's SwapHistory itself (own component, own test).
  it('swap carries v1\'s "Recent swaps" below the card, same shared store — hidden until there is a record', () => {
    useSwapHistory.setState({ records: [] })
    render(<AppShell tab="swap" />)
    expect(screen.queryByText(/Recent swaps/)).toBeNull()
    cleanup()
    useSwapHistory.setState({
      records: [{ id: 'r1', date: '2026-11-05', tokenIn: 'ETH', tokenOut: 'USDC', amountIn: '1', amountOut: '2487.6842', txHash: '0xabc', status: 'confirmed', chainId: 1 }],
    })
    render(<AppShell tab="swap" />)
    expect(screen.getByText('Recent swaps (1)')).toBeTruthy()
    useSwapHistory.setState({ records: [] })
  })

  it('dca mounts the DCA card (B6a) on a live DCA chain, not the placeholder', () => {
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    render(<AppShell tab="dca" />)
    const pane = document.querySelector('[data-tab-pane="dca"]')
    expect(pane).not.toBeNull() // the stubbed card above; the real one is tested in dca/
    expect(pane?.querySelectorAll('.ts-v2-skeleton').length).toBe(0)
  })

  it.each(['orders', 'history', 'portfolio', 'analytics'] as const)('%s mounts its B7/B8/B9 tab, not the placeholder', (tab) => {
    render(<AppShell tab={tab} />)
    const pane = document.querySelector(`[data-tab-pane="${tab}"]`)
    expect(pane).not.toBeNull() // the stubbed tab above; the real ones are tested in orders/ and history/
    expect(pane?.querySelectorAll('.ts-v2-skeleton').length).toBe(0)
  })

  // [H-1, A75] A direct /limit or /sltp visit has no real pane (owner decision: stays "Soon") — it must render
  // v1's ComingSoonPanel, the same teaser the DCA gate's sibling modes use, never the permanent empty skeleton.
  it.each(['limit', 'sltp'] as const)('%s renders v1\'s ComingSoonPanel, never the skeleton', (tab) => {
    useDisconnectedChainSelection.setState({ chainId: 8453 })
    render(<AppShell tab={tab} />)
    const pane = document.querySelector(`[data-tab-pane="${tab}"]`)
    expect(pane).not.toBeNull()
    expect(pane?.querySelectorAll('.ts-v2-skeleton').length).toBe(0)
    expect(pane?.hasAttribute('aria-busy')).toBe(false)
    expect(pane?.textContent).not.toBe('')
    expect(screen.getByText(tab === 'limit' ? 'Limit Orders' : 'Take Profit')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Swap Now/ })).toBeTruthy()
  })

  it('direct /limit and /sltp visits never leave the skeleton up regardless of chain', () => {
    for (const chainId of [1, 8453, 42161]) {
      cleanup()
      useDisconnectedChainSelection.setState({ chainId })
      for (const tab of ['limit', 'sltp'] as const) {
        cleanup()
        render(<AppShell tab={tab} />)
        expect(document.querySelector('.ts-v2-skeleton')).toBeNull()
      }
    }
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
    expect(h.blockCalls.at(-1)).toMatchObject({ chainId, query: { refetchInterval: 60_000, refetchIntervalInBackground: false } })
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
    for (const s of helpSections) expect(within(dialog).getByRole('button', { name: new RegExp(escapeRegExp(s.title)) })).toBeTruthy()
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

  it('♫ is a toggle button (on by default, speaker ↔ muted speaker)', async () => {
    const sounds = await import('@/lib/sounds')
    const spy = vi.spyOn(sounds, 'toggleBackgroundMusic').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<AppShell />)
    const btn = screen.getByRole('button', { name: 'Turn music off' })
    expect(icon(btn)).toBe('on')
    await act(async () => void fireEvent.click(btn))
    expect(icon(screen.getByRole('button', { name: 'Turn music on' }))).toBe('off')
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Turn music on' })))
    expect(icon(screen.getByRole('button', { name: 'Turn music off' }))).toBe('on')
    spy.mockRestore()
  })
})

// [L-2, A75] v1 copy: SwapBox is wrapped in SwapErrorBoundary (page.tsx:131) so a rendering crash shows a reset
// button instead of taking down the whole page. AppShell wraps {pane} the same way — every tab, not only Swap,
// since v2 consolidates them behind one shell.
describe('pane error boundary (L-2, v1 copy: SwapErrorBoundary)', () => {
  it('a crash in the pane shows v1\'s reset UI, not a blank page — the shell (header, tabs) survives', () => {
    h.crashSwap = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<AppShell tab="swap" />)
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset & Try Again' })).toBeTruthy()
    expect(screen.getByRole('banner')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Swap' })).toBeTruthy()
    spy.mockRestore()
  })
})
