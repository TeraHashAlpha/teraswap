// @vitest-environment jsdom
/**
 * [S-1, A75b] Second half of the shell-surfaces sweep (the Recent swaps half is shell-surfaces-sweep.test.tsx): the page chrome
 * around the Swap card — header, footer, the two fabs, the help drawer — rendered v1 against v2 with the same mocked wallet / chain,
 * v1 text ⊆ v2, 0 missing, plus the accessible names and link targets (the fabs and the X link have no visible text a text sweep
 * could catch). The Share button's text is swept in shell-surfaces-sweep.share.test.tsx (it needs the whole SwapBox mock rig).
 * Wagmi / RainbowKit / next are mocked at the module edge; both trees are the REAL components.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareContent, normalize, type AllowedRemoval } from './content-parity'

const h = vi.hoisted(() => ({ isConnected: false, walletChainId: undefined as number | undefined }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected, address: h.isConnected ? '0xd44d00000000000000000000000000000000962d' : undefined, chain: h.walletChainId ? { id: h.walletChainId } : undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 23_541_870n }),
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
    ConnectButton: Object.assign(() => null, {
      Custom: ({ children }: { children: (p: unknown) => React.ReactNode }) => children({ account: undefined, chain: undefined, openConnectModal: vi.fn(), mounted: true }),
    }),
  }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/swap', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ mode: 'dark', setMode: vi.fn() }) }))
vi.mock('@/lib/sounds', () => ({ startBackgroundMusic: vi.fn(), stopBackgroundMusic: vi.fn(), toggleBackgroundMusic: vi.fn(() => true), isBackgroundMusicOn: () => true }))
vi.mock('@/components/ChainSelector', () => ({ default: () => null }))

import V1Header from '@/components/Header'
import V1Footer from '@/components/Footer'
import V1HelpButton from '@/components/HelpButton'
import V1BackgroundMusic from '@/components/BackgroundMusic'
import V1HelpDrawer from '@/components/HelpDrawer'
import { Header as V2Header } from '../shell/Header'
import { Footer as V2Footer } from '../shell/Footer'
import { HelpFab, MusicToggle } from '../shell/Fabs'
import { HelpDrawer as V2HelpDrawer } from '../shell/HelpDrawer'

beforeEach(() => {
  h.isConnected = false
  h.walletChainId = undefined
})
afterEach(cleanup)

/** Accessible names (aria-label / title) of the controls under `root`, normalised: the fabs and the X link have no visible text. */
const names = (root: Element) =>
  Array.from(root.querySelectorAll('[aria-label],[title]'))
    .flatMap((el) => [el.getAttribute('aria-label'), el.getAttribute('title')])
    .filter((t): t is string => !!t)
    .map(normalize)

const GLYPH = 'decorative glyph / separator, aria-hidden in v2; the control keeps its accessible name (round 7 item 11, content-map)'
const THEME = 'theme toggle: v2 is dark-only, no light mode (content-map: "Theme toggle", owner A75 L-1: NOT built)'
// NOT owner-ruled: found by this sweep (A75b S-1). v2's pack-03 wording is pinned by shell.test.tsx, v1's was never carried over. Recorded
// in the content-map as "flagged" so the owner confirms the rewording or asks for v1's copy back; deleting an entry here makes the sweep fail.
const FLAGGED = 'reworded in v2 (pack 03), no owner ruling on record - flagged in the content-map for confirmation'
const allow = (reason: string, ...texts: string[]): AllowedRemoval[] => texts.map((text) => ({ text, reason }))

describe('sweep · shell surfaces · header', () => {
  it.each([['disconnected', false], ['connected', true]])('%s: v1 header text ⊆ v2, 0 missing, links kept', (_n, connected) => {
    h.isConnected = connected
    const v1 = render(<V1Header />)
    const v2 = render(<V2Header />)
    const r = compareContent(v1.container, v2.container, allow(THEME, '☽'))
    expect(r.v1Nodes).toBeGreaterThan(0) // the sweep saw v1's header, not an empty render
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    const v2Names = new Set(names(v2.container))
    // `theme: dark` is the theme toggle's accessible name - the same ruled-out control as the ☽ above.
    expect(names(v1.container).filter((n) => !v2Names.has(n) && n !== 'theme: dark')).toEqual([])
  })
})

describe('sweep · shell surfaces · footer', () => {
  it('v1 footer text, link targets and accessible names ⊆ v2', () => {
    const v1 = render(<V1Footer />)
    const v2 = render(<V2Footer />)
    // v1 prints `Fee: 0.1%`; v2 prints `Fee 0.1%` - the colon is the only difference (flagged, not ruled).
    const r = compareContent(v1.container, v2.container, [...allow(GLYPH, '|'), ...allow(FLAGGED, 'fee:')])
    expect(r.v1Nodes).toBeGreaterThan(5)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    const v2Names = new Set(names(v2.container))
    expect(names(v1.container).filter((n) => !v2Names.has(n))).toEqual([])
  })
})

describe('sweep · shell surfaces · fabs', () => {
  it('v1 Help and Music fabs: every accessible name has a v2 counterpart', () => {
    const v1 = render(<><V1HelpButton /><V1BackgroundMusic /></>)
    const v1Names = names(v1.container)
    cleanup()
    const v2 = render(<><HelpFab /><MusicToggle /></>)
    const v2Names = names(v2.container)
    // v1 names the music control by its action ("Mute background music" while on); v2 words it "Turn music off" — same control, same state.
    const EQUIV: Record<string, string> = { 'mute background music': 'turn music off', 'unmute background music': 'turn music on' }
    expect(v1Names.map((n) => EQUIV[n] ?? n).filter((n) => !v2Names.includes(n))).toEqual([])
  })
})

describe('sweep · shell surfaces · help drawer', () => {
  it('open: v1 drawer text, links and accessible names ⊆ v2 (same help-content module, X and e-mail links)', () => {
    const v1 = render(<V1HelpDrawer open onClose={() => {}} />)
    const v1Root = v1.baseElement.cloneNode(true) as HTMLElement
    cleanup()
    const v2 = render(<V2HelpDrawer open onClose={() => {}} />)
    // v1's two "need more help" links read `𝕏 Follow on X` / `✉ Contact support`; v2 words them `@TeraHash on X` / `Email support` (same targets).
    const r = compareContent(v1Root, v2.baseElement, [...allow(GLYPH, '▾', '▸', '𝕏', '✉'), ...allow(FLAGGED, 'follow on x', 'contact support')])
    expect(r.v1Nodes).toBeGreaterThan(10)
    expect(r.missingText).toEqual([])
    expect(r.missingHrefs).toEqual([])
    expect(r.staleAllow).toEqual([])
    const v2Names = new Set(names(v2.baseElement))
    expect(names(v1Root).filter((n) => !v2Names.has(n))).toEqual([])
  })
})
