// @vitest-environment jsdom
/**
 * [ADR-025] Round 7 shell (D2/D3, pack 01/03/04/05 + m02/m09): the 19 functional containers in their minimal form.
 * Same module-edge mocks as shell.test.tsx; everything under test is the real v2 shell.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ notice: true, request: vi.fn(), dismiss: vi.fn() }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 1n }),
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
vi.mock('next/navigation', () => ({ usePathname: () => '/swap', useRouter: () => ({ push: vi.fn() }) }))
// B3: these tests are about the shell, not the Swap card (its own tests mock the hooks it reads): the Swap tab pane is a placeholder here.
vi.mock('../swap/SwapCard', () => ({ SwapCard: () => <section data-tab-pane="swap" aria-busy="true" /> }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font, "IBM Plex Sans", system-ui, sans-serif' }))
vi.mock('@/hooks/useOrderNotifications', () => ({
  useNotificationPrompt: () => ({ shouldShow: h.notice, request: h.request, dismiss: h.dismiss }),
}))
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

import { AppShell } from './AppShell'
import { createV2RainbowTheme } from './rainbowkit-theme'
import { V2ToastProvider, useV2Toast, type ToastType } from './toasts'
import { resetMusicStateForTests } from './music'
import { useDisconnectedChainSelection } from '@/hooks/useChainId'

// a filled surface, a border colour or a card/control/chip radius — none may appear on a shell control
const BOX = /\b(bg-v2-surface2|border-v2-border|rounded-v2-(card|control|chip))\b/

beforeEach(() => {
  h.notice = true
  useDisconnectedChainSelection.setState({ chainId: null })
  resetMusicStateForTests()
})
afterEach(cleanup)

describe('header controls are text buttons (D3 items 4, 5)', () => {
  it('the network trigger and Connect: hairline underline, no fill, no border, no pill', () => {
    render(<AppShell />)
    const header = screen.getByRole('banner')
    expect(header.className).toMatch(/ts-v2-rule-b/)
    for (const btn of [within(header).getByRole('button', { name: /^Network:/ }), within(header).getByRole('button', { name: /connect/i })]) {
      expect(btn.className).toMatch(/ts-v2-underline/)
      expect(btn.className).toMatch(/bg-transparent/)
      expect(btn.className).not.toMatch(BOX)
      expect(btn.className).not.toMatch(/rounded-full|\bborder\b/)
    }
  })

  it('the dropdown is a solid popover: --surface, one hairline, square, no shadow; the current row is set off by two hairlines, not a fill', () => {
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: /^Network:/ }))
    const list = screen.getByRole('listbox', { name: 'Networks' })
    expect(list.getAttribute('data-surface')).toBe('popover')
    expect(list.className).toMatch(/\bbg-v2-surface\b/)
    expect(list.className).toMatch(/border-\[color:var\(--hairline\)\]/)
    expect(list.className).not.toMatch(/rounded|shadow/)
    const selected = within(list).getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true')!
    expect(selected.className).toMatch(/inset_0_1px_0_var\(--hairline\)/)
    for (const o of within(list).getAllByRole('option')) expect(o.className).not.toMatch(/bg-v2-surface2|rounded/)
  })
})

describe('tab strip (D3 item 8)', () => {
  it('underline tabs: the active label is cream with one cream bar; "Soon" is plain text', () => {
    render(<AppShell />)
    const tabs = screen.getAllByRole('tab')
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true')!
    expect(active.className).toMatch(/\btext-v2-cream\b/)
    expect(document.querySelectorAll('[data-tab-bar]')).toHaveLength(1)
    const soon = document.querySelectorAll('[data-tab-badge]')
    expect(soon).toHaveLength(2)
    for (const s of Array.from(soon)) expect(s.className).not.toMatch(/border|bg-|rounded/)
  })
})

describe('floating buttons (D3 item 12)', () => {
  it('♫ and ? are a 1 px hairline ring with no fill', () => {
    render(<AppShell />)
    for (const fab of [screen.getByRole('button', { name: /music/i }), screen.getByRole('button', { name: 'Open help' })]) {
      expect(fab.className).toMatch(/border-\[color:var\(--hairline-ring\)\]/)
      expect(fab.className).toMatch(/bg-transparent/)
      expect(fab.className).not.toMatch(/bg-v2-surface|border-v2-border/)
    }
  })
})

describe('banner, toasts, drawer (D3 items 14, 16)', () => {
  it('the notice banner is a strip with a 2 px accent: no border, no radius', () => {
    render(<AppShell />)
    const banner = screen.getByRole('region', { name: 'Notice' })
    expect(banner.getAttribute('data-surface')).toBe('strip')
    expect(banner.className).toMatch(/\bborder-l-2\b/)
    expect(banner.className).toMatch(/\bborder-v2-teal\b/)
    expect(banner.className).not.toMatch(BOX)
    expect(banner.className).not.toMatch(/rounded|\bborder\b(?!-)/)
    fireEvent.click(within(banner).getByRole('button', { name: 'Enable' }))
    expect(h.request).toHaveBeenCalled()
    expect(within(banner).getByRole('button', { name: 'Enable' }).className).toMatch(/ts-v2-underline/)
  })

  it.each([
    ['success', 'border-v2-green'],
    ['error', 'border-v2-red'],
    ['warning', 'border-v2-amber'],
    ['info', 'border-v2-teal'],
    ['loading', 'border-v2-cream'],
  ] as const)('a %s toast is a solid strip with a 2 px %s accent — same surface for all', (type: ToastType, accent) => {
    function Fire() {
      const { toast } = useV2Toast()
      return <button onClick={() => toast({ type, title: `t-${type}` })}>fire</button>
    }
    render(<V2ToastProvider><Fire /></V2ToastProvider>)
    fireEvent.click(screen.getByText('fire'))
    const el = document.querySelector(`[data-toast-type="${type}"]`)!
    expect(el.getAttribute('data-surface')).toBe('strip')
    expect(el.className).toMatch(/\bborder-l-2\b/)
    expect(el.className).toMatch(new RegExp(`\\b${accent}\\b`))
    expect(el.className).not.toMatch(BOX)
    expect(el.className).not.toMatch(/rounded|overflow-hidden/)
    expect(el.querySelector('.absolute')).toBeNull() // the old absolutely-positioned bar is gone
  })

  it('the help drawer is a solid --bg sheet with a left hairline only; search is an underline input; answers are indented, unboxed', () => {
    render(<AppShell />)
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }))
    const drawer = screen.getByRole('dialog')
    expect(drawer.getAttribute('data-surface')).toBe('sheet')
    expect(drawer.className).toMatch(/\bbg-v2-bg\b/)
    expect(drawer.className).toMatch(/ts-v2-rule-l/)
    expect(drawer.className).not.toMatch(/ts-v2-rule-t|border-l\b|rounded|bg-v2-surface/)
    const search = within(drawer).getByRole('searchbox', { name: 'Search help' })
    expect(search.className).toMatch(/ts-v2-input/)
    expect(search.className).not.toMatch(BOX)
    // an open group is indented under one hairline; an open answer has no surrounding box
    const section = within(drawer).getAllByRole('button', { expanded: true })[0]
    expect(section).toBeTruthy()
    const group = drawer.querySelector('.ts-v2-rule-l.pl-3')
    expect(group).not.toBeNull()
    fireEvent.click(within(group as HTMLElement).getAllByRole('button')[0])
    const answer = (group as HTMLElement).querySelector('p')!
    expect(answer.className).not.toMatch(/border|bg-v2|rounded/)
    for (const a of within(drawer).getAllByRole('link')) expect(a.className).toMatch(/ts-v2-underline/)
  })
})

describe('shell on the photo, not on a column (D2)', () => {
  it('the photo carries one uniform app scrim; there is no solid mobile column', () => {
    render(<AppShell />)
    expect(document.querySelectorAll('[data-photo-scrim]')).toHaveLength(1)
    expect((document.querySelector('[data-ts-column]') as HTMLElement).className).not.toMatch(/bg-v2/)
  })

  it('RainbowKit modal theme: solid --bg, square, hairline border, Plex Sans', () => {
    const t = createV2RainbowTheme()
    expect(t.colors.modalBackground).toBe('#0B0D0F')
    expect(t.colors.modalBorder).toBe('rgba(234,223,182,.16)')
    expect(t.radii.modal).toBe('0px')
    expect(t.radii.modalMobile).toBe('0px')
    expect(t.fonts.body).toContain('IBM Plex Sans')
  })
})

describe('the account popover is a popover surface with text actions', () => {
  it('source: popover, text actions with underline, Disconnect is a danger text button', () => {
    const src = readFileSync(join(__dirname, 'AccountPanel.tsx'), 'utf8')
    expect(src).toMatch(/variant="popover"/)
    expect(src).toMatch(/variant="text"\s+tone="danger"/)
    expect(src).toMatch(/ts-v2-underline/)
  })
})

