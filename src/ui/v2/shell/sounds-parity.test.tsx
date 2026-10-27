// @vitest-environment jsdom
/**
 * [ADR-025] Sound parity table (pack README §6): every shell interaction produces exactly the audio v1 produces for
 * the same moment. The REAL `src/lib/sounds.ts` runs; only `Audio` is faked and every play()/pause() is logged.
 * Method per row: run v1's function directly → baseline log; run the v2 interaction on a fresh page → must be equal.
 *
 * | v2 interaction (shell)                  | v1 function (caller)                              | audio                          |
 * | tab click                               | playTouchMP3 (page.tsx ModeTabs onSelect)         | touch.mp3 · 0.5 · once         |
 * | first click / key / scroll              | startBackgroundMusic (BackgroundMusic.tsx)        | background.mp3 · 0.08 · loop   |
 * | ♫ off (music playing)                   | toggleBackgroundMusic → stopBackgroundMusic       | background.mp3 paused          |
 * | ♫ on                                    | toggleBackgroundMusic → startBackgroundMusic      | background.mp3 · 0.08 · loop   |
 * | UI sound while music is off             | playTouchMP3                                      | touch.mp3 still plays          |
 * | help / network / connect / toasts       | none in v1                                        | silence                        |
 * | waiting · quote-received · confirm · cancel | SwapBox/DCAPanel/… (B3/B5 wire them)          | NOT in the shell (source scan) |
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    ConnectButton: { Custom: ({ children }: { children: (p: unknown) => React.ReactNode }) => children({ account: undefined, chain: undefined, openConnectModal: vi.fn(), mounted: true }) },
  }
})
vi.mock('next/navigation', () => ({ usePathname: () => '/swap', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))

type Event = { op: 'play' | 'pause'; src: string; volume: number; loop: boolean }
let log: Event[] = []

class FakeAudio {
  src: string
  volume = 1
  loop = false
  preload = ''
  currentTime = 0
  paused = true
  constructor(src = '') {
    this.src = src
  }
  cloneNode() {
    return new FakeAudio(this.src)
  }
  play() {
    this.paused = false
    log.push({ op: 'play', src: this.src, volume: this.volume, loop: this.loop })
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    log.push({ op: 'pause', src: this.src, volume: this.volume, loop: this.loop })
  }
}

/** A fresh page: new module registry (sounds.ts and music.ts module state reset), empty log. */
async function freshPage() {
  vi.resetModules()
  log = []
  vi.stubGlobal('Audio', FakeAudio)
  const sounds = await import('@/lib/sounds')
  const { AppShell } = await import('./AppShell')
  return { sounds, AppShell }
}

/** Which speaker the ♫ button shows (round-6 icons replaced the ♫ / ✕ glyphs). */
const icon = (btn: HTMLElement) => btn.querySelector('svg[data-music-icon]')?.getAttribute('data-music-icon')

const TOUCH: Event = { op: 'play', src: '/sounds/touch.mp3', volume: 0.5, loop: false }
const MUSIC_ON: Event = { op: 'play', src: '/sounds/background.mp3', volume: 0.08, loop: true }

async function baseline(run: (s: typeof import('@/lib/sounds')) => void): Promise<Event[]> {
  const { sounds } = await freshPage()
  run(sounds)
  return log
}

beforeEach(() => vi.useRealTimers())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('sound parity — shell vs v1 (real sounds.ts, mocked audio)', () => {
  it('tab click = playTouchMP3 (touch.mp3, 0.5)', async () => {
    const expected = await baseline((s) => s.playTouchMP3())
    expect(expected).toEqual([TOUCH])
    const { AppShell } = await freshPage()
    render(<AppShell />)
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true }))) // music already started
    log.length = 0
    fireEvent.click(screen.getByRole('tab', { name: 'Portfolio' }))
    expect(log).toEqual(expected)
  })

  it('…and when the tab click is the visitor\'s FIRST interaction: touch, then the music starts (v1 does both too)', async () => {
    const expected = await baseline((s) => {
      s.playTouchMP3() // ModeTabs onSelect (React handler, runs first)
      s.startBackgroundMusic() // BackgroundMusic's document click listener (bubbles after)
    })
    expect(expected).toEqual([TOUCH, MUSIC_ON])
    const { AppShell } = await freshPage()
    render(<AppShell />)
    fireEvent.click(screen.getByRole('tab', { name: 'Portfolio' }))
    expect(log).toEqual(expected)
  })

  it.each([
    ['click', (el: Document) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))],
    ['keydown', (el: Document) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))],
    ['scroll', (el: Document) => el.dispatchEvent(new Event('scroll'))],
  ])('first %s starts the music exactly like v1 (background.mp3, 0.08, loop) — and only once', async (_name, fire) => {
    const expected = await baseline((s) => s.startBackgroundMusic())
    expect(expected).toEqual([MUSIC_ON])
    const { AppShell } = await freshPage()
    render(<AppShell />)
    expect(log).toEqual([]) // nothing plays before an interaction (autoplay rule)
    act(() => void fire(document))
    expect(log).toEqual(expected)
    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'b' }))
    })
    expect(log).toEqual(expected)
  })

  it('♫ off then on = toggleBackgroundMusic twice: pause, then a fresh 0.08 loop', async () => {
    const expected = await baseline((s) => {
      s.startBackgroundMusic()
      log.length = 0
      s.toggleBackgroundMusic()
      s.toggleBackgroundMusic()
    })
    expect(expected.map((e) => e.op)).toEqual(['pause', 'play'])
    const { AppShell } = await freshPage()
    render(<AppShell />)
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true }))) // music running
    log.length = 0
    const off = screen.getByRole('button', { name: 'Turn music off' })
    expect(icon(off)).toBe('on')
    fireEvent.click(off)
    const on = screen.getByRole('button', { name: 'Turn music on' })
    expect(icon(on)).toBe('off')
    fireEvent.click(on)
    expect(log).toEqual(expected)
  })

  it('♫ as the very first interaction mutes without v1\'s auto-start undoing it (document listener not reached)', async () => {
    const { AppShell } = await freshPage()
    render(<AppShell />)
    // The listener v1's root BackgroundMusic adds on `document`; the toggle must not reach it.
    const v1Start = vi.fn()
    document.addEventListener('click', v1Start)
    fireEvent.click(screen.getByRole('button', { name: 'Turn music off' }))
    document.removeEventListener('click', v1Start)
    expect(v1Start).not.toHaveBeenCalled()
    expect(log.filter((e) => e.src.includes('background')).every((e) => e.op === 'pause' || !e.loop)).toBe(true)
    expect(log.some((e) => e.op === 'play')).toBe(false)
    // …and a later click anywhere does not start it either (v1: the toggle counts as the first interaction).
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(log.some((e) => e.op === 'play')).toBe(false)
  })

  it('♫ toggles ONLY the music: with it off, a tab click still plays touch.mp3', async () => {
    const { AppShell } = await freshPage()
    render(<AppShell />)
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    fireEvent.click(screen.getByRole('button', { name: 'Turn music off' }))
    log.length = 0
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(log).toEqual([TOUCH])
  })

  it('remounting the shell (tab navigation) neither restarts nor un-mutes the music', async () => {
    const { AppShell } = await freshPage()
    const first = render(<AppShell />)
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    fireEvent.click(screen.getByRole('button', { name: 'Turn music off' }))
    first.unmount()
    log.length = 0
    render(<AppShell />)
    expect(icon(screen.getByRole('button', { name: 'Turn music on' }))).toBe('off')
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(log.some((e) => e.op === 'play')).toBe(false)
  })

  it('help, network menu, connect and the ? / ✕ controls make no sound in v1, none in v2', async () => {
    const { AppShell } = await freshPage()
    render(<AppShell />)
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true }))) // music already started
    log.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Open help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close help' }))
    fireEvent.click(screen.getByRole('button', { name: /^Network:/ }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: /connect/i }))
    expect(log).toEqual([])
  })
})

describe('sounds that belong to later blocks are NOT wired in the shell', () => {
  it('no shell source references waiting / quote-received / confirm / cancel / click synths', () => {
    const forbidden = /startWaitingSound|stopWaitingSound|playQuoteReceived|playSwapConfirmMP3|playCancelOrderMP3|playClick|playTokenSelect|playApproval|playSwapInitiated|playSwapSuccess|playDCABuy|playLimitPlaced|playTriggerAlert|playError/
    const offenders = readdirSync(__dirname)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
      .filter((f) => forbidden.test(readFileSync(join(__dirname, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the shell calls only the v1 functions in the table (touch, background start/toggle)', () => {
    const used = new Set<string>()
    for (const f of readdirSync(__dirname).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))) {
      const src = readFileSync(join(__dirname, f), 'utf8')
      for (const m of src.matchAll(/import \{([^}]+)\} from '@\/lib\/sounds'/g)) m[1].split(',').forEach((n) => used.add(n.trim()))
    }
    expect([...used].sort()).toEqual(['playTouchMP3', 'startBackgroundMusic', 'toggleBackgroundMusic'])
  })
})
