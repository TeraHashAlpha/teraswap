// @vitest-environment jsdom
/**
 * [fix/ui-v2-walkthrough-polish C1] The sound button mutes ALL sound, in v1 and v2.
 *
 * Owner decision: off = silence. Before, the button only stopped the background music; touch, quote, confirm and the
 * Web Audio synths kept playing. The one flag now lives in the shared engine (`src/lib/sounds.ts`) and the existing
 * `toggleBackgroundMusic()` flips it, so the v1 button (BackgroundMusic) and the v2 button (shell MusicToggle) behave
 * the same with no change to who calls what.
 *
 * The real engine runs. Only `Audio` and `AudioContext` are fakes that record what the engine asks of them.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// ── Fakes ────────────────────────────────────────────────────────────────────────────────────────────────────────
type AudioEvent = { op: 'play' | 'pause'; src: string; loop: boolean }
let audioLog: AudioEvent[] = []
let audioConstructed = 0
let audioCloned = 0
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
    audioConstructed++
  }
  cloneNode() {
    audioCloned++
    const c = new FakeAudio(this.src)
    audioConstructed-- // a clone is counted as a clone, not as a second constructor call
    return c
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

type Sounds = typeof import('./sounds')

/** A fresh page: new module registry (engine flag back to its default), empty logs, fakes installed. */
async function freshEngine(): Promise<Sounds> {
  vi.resetModules()
  audioLog = []
  audioConstructed = 0
  audioCloned = 0
  ctxConstructed = 0
  ctxNodes = 0
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return import('./sounds')
}

const audioTouched = () => audioConstructed + audioCloned + audioLog.length
const ctxTouched = () => ctxConstructed + ctxNodes

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ── What the engine exports, classified. A new export fails the completeness test until someone decides. ───────────
/** play and start: must be a no-op while sound is off. `via` = which fake proves it plays when on. */
const SILENCED: Record<string, 'audio' | 'ctx'> = {
  playTouchMP3: 'audio',
  playSwapConfirmMP3: 'audio',
  playCancelOrderMP3: 'audio',
  startBackgroundMusic: 'audio',
  startWaitingSound: 'audio',
  playClick: 'ctx',
  playQuoteReceived: 'ctx',
  playTokenSelect: 'ctx',
  playApproval: 'ctx',
  playSwapInitiated: 'ctx',
  playSwapSuccess: 'ctx',
  playDCABuy: 'ctx',
  playLimitPlaced: 'ctx',
  playTriggerAlert: 'ctx',
  playError: 'ctx',
}
/** Controls and readers: they stop or report, they never make a sound. */
const CONTROLS = ['stopBackgroundMusic', 'stopWaitingSound', 'toggleBackgroundMusic', 'isBackgroundMusicPlaying']

describe('sounds.ts exports are all classified', () => {
  it('every export is either silenced-when-off or a control; no play and start is missing from the table', async () => {
    const s = await freshEngine()
    const names = Object.keys(s).sort()
    expect(names).toEqual([...Object.keys(SILENCED), ...CONTROLS].sort())
    for (const n of names) if (/^(play|start)/.test(n)) expect(SILENCED).toHaveProperty(n)
  })
})

describe('sound off = silence', () => {
  it.each(Object.keys(SILENCED))('%s with sound off creates no Audio and no AudioContext node', async (name) => {
    const s = await freshEngine()
    expect(s.toggleBackgroundMusic()).toBe(false)
    expect(audioTouched()).toBe(0) // muting a quiet page makes no sound either
    ;(s as unknown as Record<string, () => void>)[name]()
    expect(audioTouched()).toBe(0)
    expect(ctxTouched()).toBe(0)
    expect(audioLog.filter((e) => e.op === 'play')).toEqual([])
  })

  it('a waiting loop that is playing is stopped by the mute, and a new one does not start', async () => {
    const s = await freshEngine()
    s.startWaitingSound()
    expect(audioLog).toEqual([{ op: 'play', src: '/sounds/waiting.mp3', loop: true }])
    s.toggleBackgroundMusic()
    expect(audioLog.at(-1)).toEqual({ op: 'pause', src: '/sounds/waiting.mp3', loop: true })
    const after = audioLog.length
    s.startWaitingSound()
    expect(audioLog).toHaveLength(after)
  })

  it('the music is stopped by the mute too, and a stale first-interaction start does not undo it', async () => {
    const s = await freshEngine()
    s.startBackgroundMusic()
    expect(s.isBackgroundMusicPlaying()).toBe(true)
    s.toggleBackgroundMusic()
    expect(s.isBackgroundMusicPlaying()).toBe(false)
    expect(audioLog.at(-1)).toMatchObject({ op: 'pause', src: '/sounds/background.mp3' })
    s.startBackgroundMusic()
    expect(audioLog.filter((e) => e.op === 'play')).toHaveLength(1)
  })
})

describe('sound on again = plays', () => {
  it('default is on: nothing has to be switched for the first sound', async () => {
    const s = await freshEngine()
    s.playTouchMP3()
    expect(audioLog.filter((e) => e.op === 'play')).toHaveLength(1)
  })

  it.each(Object.entries(SILENCED))('%s plays after off then on (%s)', async (name, via) => {
    const s = await freshEngine()
    expect(s.toggleBackgroundMusic()).toBe(false)
    expect(s.toggleBackgroundMusic()).toBe(true) // on again; this also restarts the music, so measure from here
    audioLog = []
    audioConstructed = 0
    audioCloned = 0
    ;(s as unknown as Record<string, () => void>)[name]()
    if (via === 'audio') {
      // startBackgroundMusic is a no-op by design when the music already runs (the toggle just restarted it).
      if (name === 'startBackgroundMusic') expect(s.isBackgroundMusicPlaying()).toBe(true)
      else expect(audioLog.filter((e) => e.op === 'play')).toHaveLength(1)
    } else {
      expect(ctxConstructed).toBe(1)
      expect(ctxNodes).toBeGreaterThan(0)
    }
  })
})

// ── The two buttons ──────────────────────────────────────────────────────────────────────────────────────────────
describe('the v1 button silences touch sounds (the v2 button has its own test beside the shell)', () => {
  it('v1 BackgroundMusic: "Mute sound" silences touch.mp3 and the synths; "Unmute sound" brings them back', async () => {
    const s = await freshEngine()
    const { default: BackgroundMusic } = await import('@/components/BackgroundMusic')
    render(<BackgroundMusic />)
    const mute = screen.getByRole('button', { name: 'Mute sound' })
    expect(mute.getAttribute('title')).toBe('Mute sound')
    fireEvent.click(mute)
    audioLog = []
    s.playTouchMP3()
    s.playQuoteReceived()
    expect(audioLog).toEqual([])
    expect(ctxTouched()).toBe(0)
    const unmute = screen.getByRole('button', { name: 'Unmute sound' })
    expect(unmute.getAttribute('title')).toBe('Unmute sound')
    fireEvent.click(unmute)
    audioLog = []
    s.playTouchMP3()
    expect(audioLog.filter((e) => e.op === 'play' && e.src === '/sounds/touch.mp3')).toHaveLength(1)
  })

  it('the v1 button stops a playing waiting loop', async () => {
    const s = await freshEngine()
    s.startWaitingSound()
    const { default: BackgroundMusic } = await import('@/components/BackgroundMusic')
    render(<BackgroundMusic />)
    fireEvent.click(screen.getByRole('button', { name: 'Mute sound' }))
    expect(audioLog.at(-1)).toEqual({ op: 'pause', src: '/sounds/waiting.mp3', loop: true })
  })
})
