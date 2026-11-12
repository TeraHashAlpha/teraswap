// @vitest-environment jsdom
/**
 * [ADR-025 / B9 C1] Analytics tab parity. v1's three Analytics components (AnalyticsDashboard = the tab, PublicProtocolStats +
 * PersonalDashboard = the /analytics page) and the v2 tab are rendered against ONE mocked answer per state and compared: every
 * visible v1 string and link is in v2 (0 missing), and every figure v2 prints is the figure v1 prints for the same fixture (the
 * period selector walked through all four periods). The hooks' reads, the wallet and `/api/stats` are mocked; nothing hits a network.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fmtInt } from '@/lib/format'
import { compareContent } from '../__tests__/content-parity'
import { DASHBOARD, EMPTY_DASHBOARD, NOW, PERSONAL, STATS, TRADES } from './analytics-fixtures'

const h = vi.hoisted(() => ({
  analytics: { dashboard: null as unknown, loading: false },
  personal: { data: null as unknown, isLoading: false, error: null as string | null },
  account: { address: '0xd44d00000000000000000000000000000000962d', isConnected: true },
  stats: null as unknown,
  statsOk: true,
  statsHang: false,
}))

vi.mock('@/hooks/useAnalytics', () => ({ useAnalytics: () => h.analytics }))
vi.mock('@/hooks/usePersonalAnalytics', () => ({ usePersonalAnalytics: () => h.personal }))
vi.mock('wagmi', () => ({ useAccount: () => h.account }))
vi.mock('@rainbow-me/rainbowkit', () => ({ ConnectButton: () => null }))

import AnalyticsDashboard from '@/components/AnalyticsDashboard'
import PersonalDashboard from '@/components/PersonalDashboard'
import PublicProtocolStats from '@/components/PublicProtocolStats'
import type { PublicStatsPayload } from '@/lib/public-stats-display'
import { AnalyticsTab } from './AnalyticsTab'

const fetchMock = vi.fn(async (_url: string) => {
  if (h.statsHang) return new Promise<Response>(() => {})
  return { ok: h.statsOk, status: h.statsOk ? 200 : 500, json: async () => h.stats } as Response
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  h.analytics = { dashboard: DASHBOARD, loading: false }
  h.personal = { data: PERSONAL, isLoading: false, error: null }
  h.account = { address: PERSONAL.wallet, isConnected: true }
  h.stats = STATS
  h.statsOk = true
  h.statsHang = false
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Let the mount-time `/api/stats` read settle (fake timers fake only Date, so microtasks run). */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

/**
 * v1's surfaces, in v1's order: the tab (AnalyticsDashboard), then the /analytics page body (Protocol performance, and My Analytics
 * for a connected wallet — page.tsx gates it). The stats payload the page would have read is passed in, as page.tsx does.
 */
function V1({ stats, connected = true, statsState = 'ready' }: { stats: PublicStatsPayload | null; connected?: boolean; statsState?: 'ready' | 'loading' | 'failed' }): ReactElement {
  return (
    <div>
      <AnalyticsDashboard />
      <PublicProtocolStats payload={statsState === 'ready' ? stats : null} loading={statsState === 'loading'} failed={statsState === 'failed'} />
      {connected && <PersonalDashboard />}
    </div>
  )
}

async function both(opts: { statsState?: 'ready' | 'loading' | 'failed'; connected?: boolean } = {}) {
  const { statsState = 'ready', connected = h.account.isConnected } = opts
  const v1 = render(<V1 stats={h.stats as PublicStatsPayload | null} connected={connected} statsState={statsState} />)
  await settle() // v1's AnalyticsDashboard reads /api/stats itself for Gasless Adoption
  const v1Root = v1.container.cloneNode(true) as HTMLElement
  cleanup()
  fetchMock.mockClear()
  const v2 = render(<AnalyticsTab />)
  await settle()
  return { v1Root, v2: v2.container, r: compareContent(v1Root, v2.container) }
}

function expectParity(r: ReturnType<typeof compareContent>) {
  expect(r.missingText).toEqual([])
  expect(r.missingHrefs).toEqual([])
  expect(r.staleAllow).toEqual([])
}

describe('B9 · content parity: v1 Analytics ⊆ v2, per state (0 missing)', () => {
  it('ready: every section of the tab and of the /analytics page, every string and link', async () => {
    const { r, v2 } = await both()
    expect(r.v1Nodes).toBeGreaterThan(120)
    expect(r.v1Hrefs).toBeGreaterThan(8)
    expectParity(r)
    // the order is v1's: period → KPIs → Gasless Adoption → Best Routes / Popular Pairs → Volume Trend → Recent Activity → Protocol performance → My Analytics
    const text = v2.textContent ?? ''
    const order = ['All Time', 'Protocol Volume', 'Gasless Adoption', 'Best Routes', 'Popular Pairs', 'Volume Trend (30d)', 'Recent Activity', 'Protocol performance', 'My Analytics']
    const at = order.map((s) => text.indexOf(s))
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  it.each([
    ['24h', '24H'],
    ['7d', '7D'],
    ['30d', '30D'],
    ['all', 'All Time'],
  ] as const)('period %s: the KPIs are v1\'s for the same fixture (selector walked in both)', async (_p, label) => {
    const v1 = render(<AnalyticsDashboard />)
    await settle()
    fireEvent.click(within(v1.container).getByRole('button', { name: label }))
    // v1's three StatCard values (Protocol Volume, Users, Avg Trade) are its first three `text-xl font-bold` nodes
    const v1Values = Array.from(v1.container.querySelectorAll('.text-xl.font-bold')).slice(0, 3).map((n) => n.textContent)
    const v1Root = v1.container.cloneNode(true) as HTMLElement
    cleanup()

    const v2 = render(<AnalyticsTab />)
    await settle()
    fireEvent.click(within(v2.container).getByRole('tab', { name: label }))
    const v2Values = Array.from(within(v2.container).getByTestId('analytics-kpis').querySelectorAll('.ts-an-value')).map((n) => n.textContent)
    expect(v1Values).toHaveLength(3)
    expect(v2Values).toEqual(v1Values)
    expect(compareContent(v1Root, v2.container).missingText).toEqual([])
  })

  it('the literal figures for the all-time fixture (v1 and v2 print the same)', async () => {
    const { v2 } = await both()
    const kpis = within(v2).getByTestId('analytics-kpis').textContent ?? ''
    expect(kpis).toContain('$16.6K')
    expect(kpis).toContain('69 trades')
    expect(kpis).toContain('10')
    expect(kpis).toContain('unique wallets')
    expect(kpis).toContain('$239.97') // 16 558.2 / 69, v1's own division
  })

  it('a period with no trades: Avg Trade is v1\'s "$0"', async () => {
    h.analytics = { dashboard: { ...DASHBOARD, last7d: { totalVolume: 0, totalFees: 0, tradeCount: 0, uniqueWallets: 0 } }, loading: false }
    const v2 = render(<AnalyticsTab />)
    await settle()
    fireEvent.click(within(v2.container).getByRole('tab', { name: '7D' }))
    expect(within(v2.container).getByTestId('analytics-kpis').textContent).toContain('$0')
  })

  it('loading: "Loading analytics..." (v1)', async () => {
    h.analytics = { dashboard: null, loading: true }
    const { r, v2 } = await both()
    expectParity(r)
    expect(within(v2).getByTestId('analytics-loading').textContent).toBe('Loading analytics...')
  })

  it('no dashboard and not loading: v1 draws nothing for the tab. V2 draws nothing for it either', async () => {
    h.analytics = { dashboard: null, loading: false }
    const { r, v2 } = await both()
    expectParity(r)
    expect(within(v2).queryByTestId('analytics-kpis')).toBeNull()
    expect(within(v2).queryByTestId('analytics-loading')).toBeNull()
  })

  it('empty tab data: no Best Routes / Popular Pairs / Volume Trend; v1\'s empty-activity sentence', async () => {
    h.analytics = { dashboard: EMPTY_DASHBOARD, loading: false }
    const { r, v2 } = await both()
    expectParity(r)
    expect(within(v2).queryByTestId('best-routes')).toBeNull()
    expect(within(v2).queryByTestId('popular-pairs')).toBeNull()
    expect(within(v2).queryByTestId('volume-trend')).toBeNull()
    expect(within(v2).getByTestId('activity-empty').textContent).toBe('No trades recorded yet. Execute a swap to see activity here.')
    expect(within(v2).getByTestId('analytics-kpis').textContent).toContain('$0')
  })

  it('Gasless Adoption is hidden until there is a gasless swap (v1), and when /api/stats fails', async () => {
    h.stats = { ...STATS, gasless: { ...STATS.gasless, totalGaslessSwaps: 0 } }
    let { r, v2 } = await both()
    expectParity(r)
    expect(within(v2).queryByTestId('gasless-adoption')).toBeNull()
    cleanup()
    h.stats = STATS
    h.statsOk = false
    ;({ r, v2 } = await both({ statsState: 'failed' }))
    expectParity(r)
    expect(within(v2).queryByTestId('gasless-adoption')).toBeNull()
  })

  it.each([
    ['loading', 'loading'],
    ['failed', 'failed'],
  ] as const)('Protocol performance, %s: v1\'s sentence', async (_n, statsState) => {
    if (statsState === 'loading') h.statsHang = true
    else h.statsOk = false
    const { r, v2 } = await both({ statsState })
    expectParity(r)
    const section = within(v2).getByTestId('public-protocol-stats')
    expect(section.textContent).toMatch(statsState === 'loading' ? /Loading protocol stats…/ : /Protocol performance is not available yet\. Could not load protocol stats from the server\./)
  })

  it('Protocol performance, backend off / empty lists: v1\'s "not available yet" notes', async () => {
    h.stats = { enabled: true, totalSwaps: 0, totalQuotes: undefined, topSwapSources: [], topQuoteWinners: [['x', 0]], gasless: {} }
    const { r, v2 } = await both()
    expectParity(r)
    expect(within(v2).getByTestId('protocol-metric-totalSwaps-unavailable').textContent).toMatch(/No swaps recorded yet\./)
    cleanup()
    h.stats = { enabled: false, error: 'Stats backend is paused' }
    const off = await both()
    expectParity(off.r)
    expect(within(off.v2).getByTestId('protocol-stats-unavailable').textContent).toBe('Protocol performance is not available yet. Stats backend is paused')
  })

  it('My Analytics: only for a connected wallet (page.tsx gates it)', async () => {
    h.account = { address: PERSONAL.wallet, isConnected: false }
    const { r, v2 } = await both({ connected: false })
    expectParity(r)
    expect(within(v2).queryByTestId('personal')).toBeNull()
  })

  it('My Analytics states: loading skeleton, "Failed to load analytics: …", "No swaps yet" + Swap Now → "/"', async () => {
    h.personal = { data: null, isLoading: true, error: null }
    let res = await both()
    expectParity(res.r)
    expect(within(res.v2).getByTestId('personal-loading').getAttribute('aria-busy')).toBe('true')
    cleanup()

    h.personal = { data: null, isLoading: false, error: 'HTTP 502' }
    res = await both()
    expectParity(res.r)
    expect(within(res.v2).getByTestId('personal-error').textContent).toBe('Failed to load analytics: HTTP 502')
    cleanup()

    h.personal = { data: { ...PERSONAL, totalSwaps: 0 }, isLoading: false, error: null }
    res = await both()
    expectParity(res.r)
    expect(res.r.missingHrefs).toEqual([])
    expect(within(res.v2).getByRole('link', { name: 'Swap Now' }).getAttribute('href')).toBe('/')
  })

  it('My Analytics: under 10 swaps there is no "When you trade"; singular wording at 1 swap', async () => {
    h.personal = { data: { ...PERSONAL, totalSwaps: 1, gaslessSwapCount: 1, gaslessRatio: 1 }, isLoading: false, error: null }
    const { r, v2 } = await both()
    expectParity(r)
    expect(v2.textContent).not.toMatch(/When you trade/)
    expect(v2.textContent).toMatch(/Aggregated across 1 swap since 2026-09-13/)
    expect(v2.textContent).toMatch(/1 gasless swap/)
  })

  it('My Analytics, 10+ swaps: "When you trade" with v1\'s day and UTC hour (midnight is 12am)', async () => {
    const { v2 } = await both()
    expect(within(v2).getByText('Mondays')).toBeTruthy()
    expect(within(v2).getByText('12am UTC')).toBeTruthy()
  })
})

describe('B9 · links', () => {
  it('Recent Activity: the tx link is v1\'s per-chain explorer (exact hostnames), new tab, no opener', async () => {
    const { v1Root, v2 } = await both()
    const hostOf = (href: string) => new URL(href).hostname
    const v1Links = Array.from(v1Root.querySelectorAll('a[title="View transaction"]'))
    const v2Links = Array.from(v2.querySelectorAll('a[title="View transaction"]')) as HTMLAnchorElement[]
    expect(v2Links.map((a) => a.getAttribute('href'))).toEqual(v1Links.map((a) => a.getAttribute('href')))
    // t1 base, t2 mainnet, t3 arbitrum — 10 rows shown, rows without a hash have no link
    expect(v2Links.slice(0, 3).map((a) => hostOf(a.href))).toEqual(['basescan.org', 'etherscan.io', 'arbiscan.io'])
    for (const a of v2Links) {
      expect(new URL(a.href).protocol).toBe('https:')
      expect(a.target).toBe('_blank')
      expect(a.rel).toBe('noopener noreferrer')
    }
    expect(within(v2).getAllByTestId('activity-row')).toHaveLength(10)
    expect(v2.textContent).not.toContain('ELEVENTH') // v1 shows the latest ten
  })

  it('Export CSV is v1\'s link for the wallet', async () => {
    const { v2 } = await both()
    const href = within(v2).getByTestId('personal-export').getAttribute('href') ?? ''
    const u = new URL(href, 'http://localhost')
    expect(u.pathname).toBe('/api/analytics/export')
    expect(u.searchParams.get('wallet')).toBe(PERSONAL.wallet)
    expect(u.searchParams.get('format')).toBe('csv')
  })
})

describe('B9 · figures', () => {
  it('Best Routes top three with v1\'s rounded win rates; Popular Pairs the top six by volume', async () => {
    const { v2 } = await both()
    const routes = within(v2).getByTestId('best-routes').textContent ?? ''
    expect(routes).toContain('68% win rate')
    expect(routes).toContain('26% win rate')
    expect(routes).toContain('6% win rate')
    expect(routes).not.toMatch(/0% win rate/) // the fourth source is not shown
    const pairs = within(v2).getByTestId('popular-pairs').textContent ?? ''
    expect(pairs).toContain('ETH/SKY')
    expect(pairs).not.toContain('SEVENTH/PAIR')
    expect(pairs).toContain('$4.1K')
  })

  it('Volume Trend: one bar per day, v1\'s tooltip on each, first and last date under it', async () => {
    const { v2 } = await both()
    const chart = within(v2).getByTestId('volume-trend')
    const bars = Array.from(chart.querySelectorAll('.ts-an-bar')) as HTMLElement[]
    expect(bars).toHaveLength(30)
    expect(bars[0].getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2}: \$[\d.,]+[KM]? \(\d+ trades\)$/)
    // a zero day keeps v1's 2 % floor; the tallest day is full height
    const heights = bars.map((b) => parseFloat(b.style.height))
    expect(Math.min(...heights)).toBe(2)
    expect(Math.max(...heights)).toBe(100)
    expect(chart.textContent).toContain(DASHBOARD.dailyVolume[0].date)
    expect(chart.textContent).toContain(DASHBOARD.dailyVolume[29].date)
  })

  it('Recent Activity age words are v1\'s', async () => {
    const { v2 } = await both()
    const rows = within(v2).getAllByTestId('activity-row').map((r) => r.textContent ?? '')
    expect(rows[0]).toContain('just now')
    expect(rows[1]).toContain('14m ago')
    expect(rows[2]).toContain('5h ago')
    expect(rows[3]).toContain('3d ago')
    expect(rows[5]).toContain('Trade executed') // no token pair → v1's placeholder
    expect(rows[6]).toContain('mystery') // an unknown type prints as itself
    expect(TRADES).toHaveLength(12)
  })

  it('Gasless Adoption and Protocol performance figures', async () => {
    const { v2 } = await both()
    const g = within(v2).getByTestId('gasless-adoption').textContent ?? ''
    expect(g).toContain('12')
    expect(g).toContain('17.4% of all swaps')
    expect(g).toContain('$38.75')
    expect(g).toContain('$3.23')
    expect(g).toContain('17%')
    const p = within(v2).getByTestId('public-protocol-stats').textContent ?? ''
    expect(p).toContain(fmtInt(1_842))
    expect(within(v2).getByTestId('protocol-chart-winners').textContent).not.toContain('Paraswap') // v1 drops zero rows
    expect(screen.queryByText('{HEADLINE SLOT}')).toBeNull() // frame-only extras are not built
  })

  it('reads /api/stats exactly once (no polling), and nothing else', async () => {
    fetchMock.mockClear()
    render(<AnalyticsTab />)
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] })
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(['/api/stats'])
  })
})
