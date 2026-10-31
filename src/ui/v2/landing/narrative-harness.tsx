/**
 * Test harness for the scroll narrative: a mocked IntersectionObserver, a matchMedia whose queries the test flips (and
 * whose `change` listeners it fires), and section rects the test scrolls. Not a test file.
 */
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import { NarrativeStack } from './NarrativeStack'
import { MOBILE_QUERY, NARRATIVE_SECTIONS, NEAR_ROOT_MARGIN, type NarrativeSectionId } from './narrative'

export const VH = 800

export class MockIO {
  static all: MockIO[] = []
  observed = new Set<Element>()
  constructor(
    public cb: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    MockIO.all.push(this)
  }
  observe = (el: Element) => void this.observed.add(el)
  unobserve = (el: Element) => void this.observed.delete(el)
  disconnect = () => void this.observed.clear()
  takeRecords = () => []
  fire(entries: Partial<IntersectionObserverEntry>[]) {
    this.cb(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}
export const nearIO = () => MockIO.all.find((o) => o.options?.rootMargin === NEAR_ROOT_MARGIN)!
export const crossingIO = () => MockIO.all.find((o) => Array.isArray(o.options?.threshold))!
export const enterIO = () => MockIO.all.find((o) => o.options?.rootMargin === '-40% 0px -60% 0px')!

const matching = new Set<string>()
const listeners = new Map<string, Set<() => void>>()
/** Flip one media query and fire its `change` listeners (what the browser does on a preference change). */
export function setMedia(query: string, matches: boolean) {
  if (matches) matching.add(query)
  else matching.delete(query)
  listeners.get(query)?.forEach((fn) => fn())
}
export const setMobile = (on: boolean) => setMedia(MOBILE_QUERY, on)

export const rects: Partial<Record<NarrativeSectionId, { top: number; bottom: number }>> = {}
/** Section i spans [y + 900 i, y + 900 (i + 1)] in viewport coordinates: y = 0 puts the first one at the top. */
export const scrollTo = (y: number) => NARRATIVE_SECTIONS.forEach((id, i) => (rects[id] = { top: y + i * 900, bottom: y + (i + 1) * 900 }))

export function installBrowser() {
  MockIO.all = []
  matching.clear()
  listeners.clear()
  vi.stubGlobal('IntersectionObserver', MockIO)
  vi.stubGlobal('innerHeight', VH)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      get matches() {
        return matching.has(q)
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => void (listeners.get(q) ?? listeners.set(q, new Set()).get(q)!).add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.get(q)?.delete(fn),
    })),
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = rects[this.getAttribute('data-ts-narrative') as NarrativeSectionId] ?? { top: 99999, bottom: 100899 }
    return { ...r, left: 0, right: 0, width: 0, height: r.bottom - r.top, x: 0, y: r.top, toJSON: () => ({}) }
  })
  scrollTo(2400) // scroll 0: the first narrative section starts well below the first screen
}

export function mountPage() {
  return render(
    <div data-ts-landing="">
      <NarrativeStack />
      <main>
        {NARRATIVE_SECTIONS.map((id) => (
          <section key={id} id={id} data-ts-narrative={id}>
            <h2>
              {id}
              <svg />
            </h2>
            <div className="ts-v2-rv" />
          </section>
        ))}
      </main>
    </div>,
  )
}

export const section = (id: string) => document.querySelector<HTMLElement>(`[data-ts-narrative="${id}"]`)!
export const layer = (id: string) => document.querySelector<HTMLElement>(`.ts-v2-nar__layer[data-photo="${id}"]`)
export const activeLayers = () => Array.from(document.querySelectorAll('.ts-v2-nar__layer[data-active]')).map((l) => l.getAttribute('data-photo'))
