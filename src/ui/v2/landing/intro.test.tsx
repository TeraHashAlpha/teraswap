// @vitest-environment jsdom
/**
 * [round 10] The landing entry animation: four words, once per browser session, skippable, never in the way.
 * The timeline itself (word slots, the 2.95 → 3.30 s sweep) is pinned from the CSS text; the browser proof
 * (frames next to the video, real clicks, scroll, no-JS) is in docs/feedback/feat-ui-v2-intro-and-banner.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTRO_SESSION_KEY, INTRO_WORDS, Intro } from './Intro'

const HERE = __dirname
const CSS = readFileSync(join(HERE, 'intro.css'), 'utf8')
const TSX = readFileSync(join(HERE, 'Intro.tsx'), 'utf8')

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }))
}

/** jsdom has no AnimationEvent, so React listens for the prefixed name; a real browser sends the plain one. Send both. */
function endAnimation(el: Element) {
  act(() => {
    for (const type of ['animationend', 'webkitAnimationEnd']) el.dispatchEvent(new Event(type, { bubbles: true }))
  })
}

const overlay = (c: HTMLElement) => c.querySelector('[data-ts-intro]')
const curtain = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-ts-intro-curtain]')

beforeEach(() => {
  sessionStorage.clear()
  stubReducedMotion(false)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('plays once per session', () => {
  it('plays on the first landing load and not on the second in the same session', () => {
    const first = render(<Intro />)
    expect(overlay(first.container)).not.toBeNull()
    expect(sessionStorage.getItem(INTRO_SESSION_KEY)).toBe('1')
    first.unmount()
    const second = render(<Intro />)
    expect(overlay(second.container)).toBeNull()
  })

  it('a new session (empty sessionStorage) plays it again', () => {
    render(<Intro />).unmount()
    sessionStorage.clear()
    expect(overlay(render(<Intro />).container)).not.toBeNull()
  })

  it('marks the session even when the visitor skips at once', () => {
    const a = render(<Intro />)
    fireEvent.click(curtain(a.container)!)
    a.unmount()
    expect(overlay(render(<Intro />).container)).toBeNull()
  })

  it('is not lost to a StrictMode double effect', async () => {
    const { StrictMode } = await import('react')
    const r = render(
      <StrictMode>
        <Intro />
      </StrictMode>,
    )
    expect(overlay(r.container)).not.toBeNull()
  })

  it('skips when sessionStorage throws: nothing can say it played, so the page is not held for it', () => {
    // Replace the whole global. `vi.spyOn(sessionStorage, 'getItem')` is NOT hermetic: on jsdom's Storage (Node 22, CI) the
    // assignment is a named-property write that stores an item called "getItem" and leaves the method alone, so the spy never
    // throws; on Node 25 `sessionStorage` is Node's own Web Storage and the same spy works. A stubbed global behaves the same on both.
    vi.stubGlobal('sessionStorage', {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
      removeItem() {},
      clear() {},
    })
    const r = render(<Intro />)
    expect(overlay(r.container)).toBeNull()
  })
})

describe('words', () => {
  it('are exactly "Compare." "Verify." "Swap." "Repeat.", in that order', () => {
    expect([...INTRO_WORDS]).toEqual(['Compare.', 'Verify.', 'Swap.', 'Repeat.'])
    const r = render(<Intro />)
    const words = Array.from(r.container.querySelectorAll('.ts-intro__word')).map((n) => n.textContent)
    expect(words).toEqual(['Compare.', 'Verify.', 'Swap.', 'Repeat.'])
  })

  it('uses no U+2014 (source, css or rendered text)', () => {
    const r = render(<Intro />)
    for (const text of [TSX, CSS, r.container.textContent ?? '']) expect(text).not.toContain('—')
  })

  it('has one slot per word of 600 ms and a last word that fades in over 250 ms and stays', () => {
    expect(CSS).toMatch(/animation:\s*ts-intro-word 600ms/)
    expect(CSS).toMatch(/animation-delay:\s*calc\(var\(--i\) \* 600ms\)/)
    expect(CSS).toMatch(/\[data-last\][^}]*ts-intro-word-last 250ms/)
    expect(CSS).toMatch(/41\.667%\s*\{\s*opacity:\s*1/) // 250 ms of 600 ms
    // nothing flashes faster than 3 per second: one change per 600 ms slot is 1.67 per second
    expect(1000 / 600).toBeLessThan(3)
  })

  it('sweeps from 2.95 s to 3.30 s', () => {
    expect(CSS).toMatch(/ts-intro-curtain 3300ms/)
    // the mask (and the rim riding on it) holds still until 2950 ms of the 3300 ms, then moves out
    for (const name of ['ts-intro-curtain', 'ts-intro-rim']) {
      const block = CSS.match(new RegExp(`@keyframes ${name} \\{\\s*0%,\\s*([\\d.]+)%`))
      expect(block, name).not.toBeNull()
      expect((Number(block![1]) / 100) * 3300).toBeCloseTo(2950, 0)
    }
    expect(CSS).toMatch(/ts-intro-rim 3300ms/)
  })

  it('uses the display face and cream token, and no colour literal of its own besides the dot-grid cream', () => {
    expect(CSS).toMatch(/font-family:\s*var\(--font-display\)/)
    expect(CSS).toMatch(/color:\s*var\(--cream\)/)
    expect(CSS).toMatch(/background-color:\s*var\(--bg\)/)
    expect(CSS).not.toMatch(/text-transform/) // the approved cut is sentence case
    const literals = CSS.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []
    expect(new Set(literals)).toEqual(new Set(['rgba(234, 223, 182, 0.05)']))
  })
})

describe('skip', () => {
  it('a click on the overlay skips it', () => {
    const r = render(<Intro />)
    fireEvent.click(curtain(r.container)!)
    expect(overlay(r.container)).toBeNull()
  })

  it('a click is taken by the curtain and does not reach a link under it', () => {
    const onLink = vi.fn()
    const r = render(
      <>
        <a href="#x" onClick={onLink}>
          under
        </a>
        <Intro />
      </>,
    )
    fireEvent.click(curtain(r.container)!)
    expect(onLink).not.toHaveBeenCalled()
  })

  for (const [name, fire] of [
    ['a key press', () => fireEvent.keyDown(window, { key: 'Tab' })],
    ['a wheel turn', () => fireEvent.wheel(window, { deltaY: 40 })],
    ['a touch drag (scroll on a phone)', () => fireEvent.touchMove(window)],
    ['a scroll', () => fireEvent.scroll(window)],
  ] as const) {
    it(`${name} skips it`, () => {
      const r = render(<Intro />)
      expect(overlay(r.container)).not.toBeNull()
      act(() => {
        fire()
      })
      expect(overlay(r.container)).toBeNull()
    })
  }

  it('never cancels the gesture: a scroll still scrolls, a key still acts', () => {
    render(<Intro />)
    const wheel = new WheelEvent('wheel', { cancelable: true, deltaY: 40 })
    const key = new KeyboardEvent('keydown', { cancelable: true, key: ' ' })
    act(() => {
      window.dispatchEvent(wheel)
    })
    expect(wheel.defaultPrevented).toBe(false)
    render(<Intro />) // already played in this session; keydown below only proves the listener is gone
    act(() => {
      window.dispatchEvent(key)
    })
    expect(key.defaultPrevented).toBe(false)
    expect(TSX).not.toMatch(/preventDefault|stopPropagation/)
  })

  it('removes its listeners once skipped', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const r = render(<Intro />)
    fireEvent.click(curtain(r.container)!)
    const removed = remove.mock.calls.map((c) => c[0])
    for (const t of ['keydown', 'wheel', 'touchmove', 'scroll']) expect(removed).toContain(t)
  })
})

describe('reduced motion', () => {
  it('prefers-reduced-motion: reduce renders no intro at all and does not use up the session flag', () => {
    stubReducedMotion(true)
    const r = render(<Intro />)
    expect(overlay(r.container)).toBeNull()
    expect(sessionStorage.getItem(INTRO_SESSION_KEY)).toBeNull()
  })

  it('the CSS also hides it, because tokens.css freezes animations under reduced motion', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ts-intro\s*\{\s*display:\s*none\s*!important/)
  })
})

describe('never in the way', () => {
  it('is aria-hidden, holds nothing focusable, and is not announced', () => {
    const r = render(<Intro />)
    const o = overlay(r.container)!
    expect(o.getAttribute('aria-hidden')).toBe('true')
    expect(o.querySelectorAll('a, button, input, select, textarea, [tabindex], [role], [aria-live]').length).toBe(0)
  })

  it('is gone from the DOM when the curtain animation ends', () => {
    const r = render(<Intro />)
    endAnimation(curtain(r.container)!)
    expect(overlay(r.container)).toBeNull()
  })

  it('an animation end that bubbles up from a word does not remove it early', () => {
    const r = render(<Intro />)
    endAnimation(r.container.querySelector('.ts-intro__word')!)
    expect(overlay(r.container)).not.toBeNull()
  })

  it('CSS alone leaves it inert: fixed, pointer-events none on the root, curtain hidden by fill-mode at the end', () => {
    expect(CSS).toMatch(/\.ts-intro\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/s)
    expect(CSS).toMatch(/\.ts-intro__curtain\s*\{[^}]*pointer-events:\s*auto/s)
    expect(CSS).toMatch(/ts-intro-curtain 3300ms linear both/)
    expect(CSS).toMatch(/@keyframes ts-intro-curtain[\s\S]*100% \{[^}]*mask-position:[^}]*visibility:\s*hidden;\s*pointer-events:\s*none/)
    expect(CSS).toMatch(/@keyframes ts-intro-rim[\s\S]*100% \{[^}]*translateY\(calc\(-100% - 4px\)\)[^}]*visibility:\s*hidden/)
  })

  it('has a <noscript> that hides it', () => {
    expect(TSX).toMatch(/<noscript>[\s\S]*\.ts-intro\{display:none!important\}[\s\S]*<\/noscript>/)
  })

  it('adds no dependency and no audio', () => {
    expect(TSX).not.toMatch(/from '(?!react'|\.\/intro\.css')/)
    expect(TSX + CSS).not.toMatch(/Audio|\.mp3|\.wav|playTouch/)
  })
})

describe('only on the landing', () => {
  const ROOT = join(HERE, '..', '..', '..') // src/
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.next') continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) sources(p, out)
      else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) out.push(p)
    }
    return out
  }

  it('is imported by the landing and by nothing else (no app tab, Docs, Privacy, Terms, v1)', () => {
    const importers = sources(ROOT)
      .filter((f) => /from ['"][^'"]*landing\/Intro['"]|from '\.\/Intro'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROOT.length + 1))
    expect(importers).toEqual(['ui/v2/landing/index.tsx'])
  })

  it('the landing is the only mount: LandingV2 renders it, AppShell and the docs-legal pages do not', () => {
    expect(readFileSync(join(HERE, 'index.tsx'), 'utf8')).toMatch(/<Intro \/>/)
    for (const f of ['shell/AppShell.tsx', 'shell/ContentShell.tsx', 'docs-legal/index.ts']) {
      let text = ''
      try {
        text = readFileSync(join(HERE, '..', f), 'utf8')
      } catch {
        continue
      }
      expect(text).not.toMatch(/Intro/)
    }
  })
})
