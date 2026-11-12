// @vitest-environment jsdom
/**
 * [fix/privacy-no-usage-tracking] The site does not record how visitors use it.
 *
 * Mounts the REAL `Providers` tree (what every v1 and v2 page sits under), loads a page, changes route,
 * clicks, hides the tab, lets every flush timer run, and proves nothing was sent to `/api/log-event`
 * (by fetch or by sendBeacon) and that no tracking session id was stored.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'

vi.mock('@/lib/rpc-guarded-transport', async () => (await import('@/test-utils/rpc-harness')).mockGuardedTransportModule())
vi.mock('@/components/BackgroundMusic', () => ({ default: () => null }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/sounds')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
})
let mockPathname = '/'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => mockPathname }))


const beacon = vi.fn(() => true)

beforeAll(() => {
  // jsdom has no IntersectionObserver; WalletConnect project id is required by the wagmi config; every fetch answers `{}`.
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
})

beforeEach(() => {
  mockPathname = '/'
  beacon.mockClear()
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true, writable: true })
  ;(globalThis.fetch as unknown as { mockClear: () => void }).mockClear()
  try { sessionStorage.clear(); localStorage.clear() } catch { /* jsdom storage unavailable */ }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const sentToLogEvent = (): string[] => {
  const viaFetch = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(([input]) => String(input))
    .filter((u) => u.includes('/api/log-event'))
  const viaBeacon = (beacon.mock.calls as unknown as unknown[][]).map(([u]) => String(u)).filter((u) => u.includes('/api/log-event'))
  return [...viaFetch, ...viaBeacon]
}

describe('Providers: no usage tracking', () => {
  it('a page load, a route change, clicks and a tab hide send nothing to /api/log-event', async () => {
    // Load modules BEFORE faking timers: the module runner needs real timers to resolve dynamic imports.
    const { default: Providers } = await import('@/app/providers')
    vi.useFakeTimers()

    const view = render(
      <Providers>
        <button type="button" data-track="cta">Swap now</button>
        <a href="/docs">Docs</a>
      </Providers>,
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })

    // route change (the old tracker sent a page_view + session_end here)
    mockPathname = '/docs'
    view.rerender(
      <Providers>
        <button type="button" data-track="cta">Swap now</button>
        <a href="/docs">Docs</a>
      </Providers>,
    )

    // meaningful clicks (the old tracker buffered these and flushed at 10 events or after 5 s)
    for (let i = 0; i < 12; i++) fireEvent.click(view.getByText('Swap now'))
    fireEvent.click(view.getByText('Docs'))

    // unload paths (the old tracker flushed on beforeunload / visibilitychange)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    window.dispatchEvent(new Event('beforeunload'))
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

    expect(sentToLogEvent()).toEqual([])
    // and no beacon at all carried a usage payload
    expect(beacon).not.toHaveBeenCalled()
  }, 60_000)

  it('stores no tracking session id', async () => {
    const { default: Providers } = await import('@/app/providers')
    vi.useFakeTimers()
    render(<Providers><button type="button">x</button></Providers>)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(sessionStorage.getItem('teraswap_session_id')).toBeNull()
    expect(localStorage.getItem('teraswap_session_id')).toBeNull()
  }, 60_000)
})
