// @vitest-environment jsdom
/**
 * [ADR-025] Sound parity table, Swap tab (pack README §6): the card makes exactly the audio v1's SwapBox makes for the same
 * moment. The REAL `src/lib/sounds.ts` runs; only the Web Audio API is faked and every node start is logged. Method per
 * row: run v1's function directly → baseline log; run the v2 interaction on a fresh page → must be equal.
 *
 * | moment                                    | v1 (SwapBox)                                   | audio                       |
 * | a quote arrives (new best source)         | effect on [meta.best.source, chain] → playQuoteReceived | sub-bass + ping, once |
 * | the poll re-quotes, same winner           | same deps → no re-run                          | silence                     |
 * | the winner changes                        | effect re-runs                                 | one more blip               |
 * | typing / ⇅ / MEV / sources / Compare / ⇄  | no sound call                                  | silence                     |
 * | CTA (any state)                           | click path is B5 (SwapButton: playTouchMP3)    | NOT wired here (source scan) |
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MetaQuoteResult } from '@/lib/adapters/types'
import { NO_ORACLE, fixtureMeta, taggedFixture } from './test-fixtures'

const h = vi.hoisted(() => ({
  quote: { meta: null as unknown, loading: false, error: null as string | null, countdown: 12, refresh: () => {} },
}))
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: true, chain: { id: 1 } }),
  useBalance: () => ({ data: { value: 3n * 10n ** 18n, decimals: 18 } }),
}))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1, useActiveChainId: () => 1 }))
vi.mock('@/hooks/useChainlinkPrice', () => ({ useChainlinkPrice: () => ({ ...NO_ORACLE, chainlinkPrice: 2490 }) }))
vi.mock('@/hooks/useEthGasCost', () => ({ useEthGasCost: () => ({ ethPrice: 2490, gasPriceGwei: 0.1, estimate: () => ({ eth: 0.000012, usd: 0.03 }) }) }))
vi.mock('@/hooks/useApproval', () => ({ useApproval: () => ({ plan: null }) }))
vi.mock('@/hooks/useSwapPriceTier', () => ({ useSwapPriceTier: () => ({ data: null, loading: false }) }))
vi.mock('./lifecycle/use-swap-lifecycle', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useSwapLifecycle: () => m.idleLifecycle() }
})
vi.mock('@/hooks/useDepegCheck', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useDepegCheck: () => m.OK_DEPEG }
})
vi.mock('../shell/toasts', async () => {
  const m = await import('./lifecycle/test-stubs')
  return { useV2Toast: () => m.TOAST_STUB }
})

type Event = { op: 'start' | 'stop'; type: string; freq: number }
let log: Event[] = []

class FakeParam {
  value = 0
  setValueAtTime(v: number) {
    this.value = v
  }
  exponentialRampToValueAtTime() {}
}
class FakeNode {
  gain = new FakeParam()
  connect(n: unknown) {
    return n
  }
}
class FakeOsc extends FakeNode {
  type = ''
  frequency = new FakeParam()
  start() {
    log.push({ op: 'start', type: this.type, freq: this.frequency.value })
  }
  stop() {
    log.push({ op: 'stop', type: this.type, freq: this.frequency.value })
  }
}
class FakeAudioContext {
  currentTime = 0
  state = 'running'
  destination = new FakeNode()
  resume() {}
  createOscillator() {
    return new FakeOsc()
  }
  createGain() {
    return new FakeNode()
  }
}

/** A fresh page: new module registry (sounds.ts's AudioContext singleton resets), empty log. */
async function freshPage() {
  vi.resetModules()
  log = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext })
  const sounds = await import('@/lib/sounds')
  const { SwapCard } = await import('./SwapCard')
  return { sounds, SwapCard }
}

const type = (v: string) => fireEvent.change(screen.getByLabelText('Sell amount'), { target: { value: v } })
const q = (over: (m: MetaQuoteResult) => void = () => {}) => {
  const m = fixtureMeta()
  over(m)
  return taggedFixture(m, '1')
}

beforeEach(() => {
  h.quote = { meta: null, loading: false, error: null, countdown: 12, refresh: () => {} }
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('quote-received sound: v2 = v1', () => {
  it('baseline: v1 plays a sub-bass + a ping (4 node events)', async () => {
    const { sounds } = await freshPage()
    sounds.playQuoteReceived()
    expect(log.map((e) => e.type)).toEqual(['sine', 'sine', 'sine', 'sine'])
    expect(log.map((e) => e.freq).filter((f) => f > 0)).toEqual([55, 55, 1200, 1200])
  })

  it('a quote arrives → exactly v1\'s sound, once', async () => {
    const { sounds } = await freshPage()
    sounds.playQuoteReceived()
    const v1 = [...log]
    const { SwapCard } = await freshPage()
    const { rerender } = render(<SwapCard />)
    type('1')
    expect(log).toEqual([]) // no quote yet → silence
    h.quote = { ...h.quote, meta: q() }
    rerender(<SwapCard />)
    expect(log).toEqual(v1)
  })

  it('the poll re-quotes and the same source still wins → silence (no new arrival)', async () => {
    const { SwapCard } = await freshPage()
    const { rerender } = render(<SwapCard />)
    type('1')
    h.quote = { ...h.quote, meta: q() }
    rerender(<SwapCard />)
    const after1 = log.length
    h.quote = { ...h.quote, meta: q((m) => (m.fetchedAt += 15_000)) }
    rerender(<SwapCard />)
    expect(log.length).toBe(after1)
  })

  it('the winner changes → one more blip', async () => {
    const { sounds } = await freshPage()
    sounds.playQuoteReceived()
    const one = log.length
    const { SwapCard } = await freshPage()
    const { rerender } = render(<SwapCard />)
    type('1')
    h.quote = { ...h.quote, meta: q() }
    rerender(<SwapCard />)
    expect(log.length).toBe(one)
    h.quote = {
      ...h.quote,
      meta: q((m) => {
        const [first, second, ...rest] = m.all
        m.all = [second, first, ...rest]
        m.best = second
      }),
    }
    rerender(<SwapCard />)
    expect(log.length).toBe(one * 2)
  })

  it('amount typed while a quote is on screen: the quote goes stale (skeleton) and the same winner re-arriving is NOT a new blip', async () => {
    const { SwapCard } = await freshPage()
    const { rerender } = render(<SwapCard />)
    type('1')
    h.quote = { ...h.quote, meta: q() }
    rerender(<SwapCard />)
    const after1 = log.length
    type('2') // the quote answers 1; the field says 2 → stale in the display, but the picked winner is unchanged (v1's `meta`)
    expect(document.querySelector('[data-quoting]')).not.toBeNull()
    expect(log.length).toBe(after1)
  })
})

describe('everything else in the card is silent in v1, so silent in v2', () => {
  it('⇅, MEV switch, sources menu, Compare, ⇄, ✎, tooltips, refresh, 50% / MAX: no audio', async () => {
    const { SwapCard } = await freshPage()
    const { rerender } = render(<SwapCard />)
    type('1')
    h.quote = { ...h.quote, meta: q() }
    rerender(<SwapCard />)
    log.length = 0
    fireEvent.click(screen.getByRole('button', { name: /sources enabled/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Close liquidity sources panel' }))
    fireEvent.click(screen.getByRole('button', { name: /Compare/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Flip rate direction' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quote' }))
    fireEvent.click(screen.getByRole('button', { name: 'Platform fee info' }))
    act(() => void fireEvent.click(document.querySelector('[data-edit-slippage]') as HTMLElement)) // opens the slippage sheet — silent too
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '50%' })) // these two change the amount: the panel goes stale, so they come after the panel's controls
    fireEvent.click(screen.getByRole('button', { name: 'MAX' }))
    fireEvent.click(screen.getByRole('switch', { name: /Force MEV Protection/ })) // last: forcing MEV hides non-CoW quotes
    expect(log).toEqual([])
  })
})

describe('the card only ever calls the sounds v1 calls (B5 wires the click path: the full table is lifecycle/sounds-parity.lifecycle.test.tsx)', () => {
  const dirs = [__dirname, join(__dirname, 'lifecycle')]
  const files = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !/^test-/.test(f)).map((f) => join(d, f)))
  // The six functions SwapBox / SwapButton import from @/lib/sounds — nothing else (no synth playClick / playApproval / playError …).
  const V1 = ['playQuoteReceived', 'playTouchMP3', 'playSwapConfirmMP3', 'playCancelOrderMP3', 'startWaitingSound', 'stopWaitingSound']
  it('every @/lib/sounds import in src/ui/v2/swap is one of the six v1 calls', () => {
    const used = new Set<string>()
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/import \{([^}]+)\} from '@\/lib\/sounds'/g)) m[1].split(',').forEach((n) => used.add(n.trim()))
    }
    expect([...used].every((n) => V1.includes(n))).toBe(true)
    expect([...used]).toContain('playQuoteReceived')
  })
  it('no synth sound v1 does not play at these moments is referenced', () => {
    const forbidden = /playClick|playTokenSelect|playApproval|playSwapInitiated|playSwapSuccess|playDCABuy|playLimitPlaced|playTriggerAlert|playError/
    expect(files.filter((f) => forbidden.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})
