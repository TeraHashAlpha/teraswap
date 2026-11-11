// @vitest-environment jsdom
/**
 * [fix/ui-v2-walkthrough-polish C1] The v2 sound button (shell MusicToggle) mutes ALL sound: it flips the one flag in the shared
 * engine (`src/lib/sounds.ts`), so touch.mp3, the Web Audio synths and a playing waiting loop go silent. The engine's own table
 * and the v1 button live in `src/lib/sounds.mute.test.tsx` (v1 files may not import v2, so the two halves sit in two trees).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────
type AudioEvent = { op: 'play' | 'pause'; src: string; loop: boolean }
let audioLog: AudioEvent[] = []
let ctxConstructed = 0
let ctxNodes = 0

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
    audioLog.push({ op: 'play', src: this.src, loop: this.loop })
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    audioLog.push({ op: 'pause', src: this.src, loop: this.loop })
  }
}

/** Any property is a callable node; `connect` returns its argument so `a.connect(b).connect(c)` chains. */
function node(): unknown {
  return new Proxy(function () {}, {
    get: (_t, p) => (p === 'connect' ? (n: unknown) => n : node()),
    apply: () => node(),
    set: () => true,
  })
}

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  sampleRate = 44100
  destination = node()
  constructor() {
    ctxConstructed++
  }
  resume() {}
  createOscillator() { ctxNodes++; return node() }
  createGain() { ctxNodes++; return node() }
  createBiquadFilter() { ctxNodes++; return node() }
  createBufferSource() { ctxNodes++; return node() }
  createBuffer() { ctxNodes++; return { getChannelData: () => new Float32Array(1) } }
}

type Sounds = typeof import('@/lib/sounds')

/** A fresh page: new module registry (engine flag back to its default), empty logs, fakes installed. */
async function freshEngine(): Promise<Sounds> {
  vi.resetModules()
  audioLog = []
  ctxConstructed = 0
  ctxNodes = 0
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return import('@/lib/sounds')
}

const ctxTouched = () => ctxConstructed + ctxNodes

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the v2 button silences all sound', () => {
  it('MusicToggle: "Mute sound" silences touch.mp3 and the synths; "Unmute sound" brings them back', async () => {
    const s = await freshEngine()
    const { MusicToggle } = await import('./Fabs')
    render(<MusicToggle />)
    const mute = screen.getByRole('button', { name: 'Mute sound' })
    expect(mute.getAttribute('title')).toBe('Mute sound')
    expect(mute.getAttribute('aria-pressed')).toBe('true')
    act(() => void fireEvent.click(mute))
    audioLog = []
    s.playTouchMP3()
    s.playSwapSuccess()
    expect(audioLog).toEqual([])
    expect(ctxTouched()).toBe(0)
    const unmute = screen.getByRole('button', { name: 'Unmute sound' })
    expect(unmute.getAttribute('title')).toBe('Unmute sound')
    act(() => void fireEvent.click(unmute))
    audioLog = []
    s.playTouchMP3()
    expect(audioLog.filter((e) => e.op === 'play' && e.src === '/sounds/touch.mp3')).toHaveLength(1)
  })

  it('stops a playing waiting loop', async () => {
    const s = await freshEngine()
    s.startWaitingSound()
    const { MusicToggle } = await import('./Fabs')
    render(<MusicToggle />)
    fireEvent.click(screen.getByRole('button', { name: 'Mute sound' }))
    expect(audioLog.at(-1)).toEqual({ op: 'pause', src: '/sounds/waiting.mp3', loop: true })
  })
})
