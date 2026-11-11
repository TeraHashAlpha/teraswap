// @vitest-environment jsdom
/**
 * [fix/quote-limiter-music-toggle] The v2 ♫ toggle showed OFF while the music played.
 *
 * Cause: the root layout still mounts v1's <BackgroundMusic/>, whose `document` listener starts the music on the
 * visitor's first click / key / scroll, and `startBackgroundMusic()` never looked at the engine's on/off flag. When the
 * first click is the v2 toggle, the toggle runs first (flag -> off), then v1's listener runs for the SAME click and
 * starts the music. MusicToggle's `e.stopPropagation()` cannot prevent that in production: Next's App Router hydrates
 * INTO `document` (next/dist/client/app-index.js: `hydrateRoot(document, …)`), so React's delegated handler and v1's
 * listener are two listeners on the same node, and stopPropagation does not stop a sibling. (The older parity test
 * renders into a <div>, where it does.) So these tests deliver the click to `document` explicitly, as production does.
 *
 * Fix under test: `startBackgroundMusic()` returns early while music is disabled (src/lib/sounds.ts).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Event = { op: 'play' | 'pause'; src: string }
let log: Event[] = []

class FakeAudio {
  src: string
  volume = 1
  loop = false
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
    log.push({ op: 'play', src: this.src })
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    log.push({ op: 'pause', src: this.src })
  }
}

const bg = (op: 'play' | 'pause') => log.filter((e) => e.op === op && e.src.includes('background.mp3'))

/** A fresh page load: new module registry (sounds.ts + music.ts flags reset), empty log, v1 root component mounted. */
async function freshPage(mount: 'v1' | 'v2') {
  vi.resetModules()
  log = []
  vi.stubGlobal('Audio', FakeAudio)
  const sounds = await import('@/lib/sounds')
  const { default: BackgroundMusic } = await import('@/components/BackgroundMusic')
  const { MusicToggle } = await import('./Fabs')
  // providers.tsx mounts BackgroundMusic at the root for BOTH versions; v2 adds its own ♫ on top.
  render(
    <>
      <BackgroundMusic />
      {mount === 'v2' ? <MusicToggle /> : null}
      <p>page</p>
    </>,
  )
  return sounds
}

/** What a click on `el` does in production: React's handler on the button, then the same event on `document`. */
function clickInProduction(el: Element) {
  fireEvent.click(el)
  act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

const v2Toggle = () => screen.getByRole('button', { name: /Turn music (on|off)/ })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('v2 ♫ toggle as the very first interaction', () => {
  it('(a) off and silent: no background.mp3 play, the button shows OFF', async () => {
    await freshPage('v2')
    clickInProduction(v2Toggle())
    expect(bg('play')).toEqual([])
    expect(v2Toggle().getAttribute('aria-label')).toBe('Turn music on')
    expect(v2Toggle().getAttribute('aria-pressed')).toBe('false')
    expect(v2Toggle().querySelector('svg[data-music-icon]')?.getAttribute('data-music-icon')).toBe('off')
  })

  it('(b) toggling on again plays background.mp3 (and only once)', async () => {
    const sounds = await freshPage('v2')
    clickInProduction(v2Toggle())
    clickInProduction(v2Toggle())
    expect(bg('play')).toHaveLength(1)
    expect(v2Toggle().getAttribute('aria-label')).toBe('Turn music off')
    expect(sounds.isBackgroundMusicPlaying()).toBe(true)
  })

  it.each([
    ['keydown', () => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }))],
    ['scroll', () => document.dispatchEvent(new Event('scroll'))],
  ])('(d) a first %s AFTER the toggle turned music off is still silent', async (_n, fire) => {
    await freshPage('v2')
    clickInProduction(v2Toggle())
    act(() => void fire())
    act(() => void fire())
    expect(bg('play')).toEqual([])
  })
})

describe('v1 is unchanged', () => {
  it('(c) the first click elsewhere starts the music; the v1 toggle stops it', async () => {
    const sounds = await freshPage('v1')
    act(() => void document.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(bg('play')).toHaveLength(1)
    expect(sounds.isBackgroundMusicPlaying()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Mute background music' }))
    expect(bg('pause')).toHaveLength(1)
    expect(sounds.isBackgroundMusicPlaying()).toBe(false)
    expect(bg('play')).toHaveLength(1)
  })

  it('(c) the v1 toggle as the very first interaction stays silent (v1 startedRef already guarded it)', async () => {
    await freshPage('v1')
    clickInProduction(screen.getByRole('button', { name: 'Mute background music' }))
    expect(bg('play')).toEqual([])
    expect(screen.getByRole('button', { name: 'Unmute background music' })).toBeTruthy()
  })
})
