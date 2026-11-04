// @vitest-environment jsdom
/**
 * [ADR-025 / B9 C2] Analytics: the chart's text alternative, keyboard, reduced-motion, the 375 layout rules and AA text contrast.
 * jsdom has no layout, so the 375 rules are pinned in the stylesheet and the rendered 375 result is the screenshot evidence in the
 * feedback file; everything else here runs on the real components.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAILY, DASHBOARD, NOW, PERSONAL, STATS } from './analytics-fixtures'
import { barTitle } from './analytics-model'

const h = vi.hoisted(() => ({ connected: true }))
vi.mock('@/hooks/useAnalytics', async () => {
  const f = await import('./analytics-fixtures')
  return { useAnalytics: () => ({ dashboard: f.DASHBOARD, loading: false }) }
})
vi.mock('@/hooks/usePersonalAnalytics', async () => {
  const f = await import('./analytics-fixtures')
  return { usePersonalAnalytics: () => ({ data: f.PERSONAL, isLoading: false, error: null }) }
})
vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0xd44d00000000000000000000000000000000962d', isConnected: h.connected }) }))

import { AnalyticsTab } from './AnalyticsTab'

const DIR = join(__dirname)
const css = readFileSync(join(DIR, 'analytics.css'), 'utf8')
const tokens = readFileSync(join(DIR, '..', 'tokens.css'), 'utf8')

beforeEach(() => {
  h.connected = true
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => STATS }) as Response))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount() {
  const r = render(<AnalyticsTab />)
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  return r.container
}

describe('B9 C2 · the Volume Trend chart', () => {
  it('is a labelled figure; the bars are decorative and the same series is available as text', async () => {
    const root = await mount()
    const fig = within(root).getByTestId('volume-trend')
    expect(fig.tagName).toBe('FIGURE')
    const heading = fig.querySelector('#' + fig.getAttribute('aria-labelledby'))
    expect(heading?.textContent).toBe('Volume Trend (30d)')
    expect(within(fig).getByTestId('volume-bars').getAttribute('aria-hidden')).toBe('true')
    const items = Array.from(within(fig).getByTestId('volume-text').querySelectorAll('li')).map((li) => li.textContent)
    expect(items).toEqual(DAILY.map(barTitle)) // v1's tooltip string for each day, in order — no new words
    expect(items).toHaveLength(30)
  })

  it('draws no chart library output (v1 uses divs): no canvas, no svg', async () => {
    const root = await mount()
    const fig = within(root).getByTestId('volume-trend')
    expect(fig.querySelector('canvas, svg')).toBeNull()
  })

  it('the bar tracks of the ranked lists are decorative: the figure beside each bar is visible text', async () => {
    const root = await mount()
    const tracks = Array.from(root.querySelectorAll('.ts-an-track'))
    expect(tracks.length).toBeGreaterThanOrEqual(3 + 3 + 2 + 5) // best routes, sources + winners, personal
    for (const t of tracks) {
      expect(t.getAttribute('aria-hidden')).toBe('true')
      expect(t.parentElement?.querySelector('.ts-an-rank-fig')?.textContent).toMatch(/\d/)
    }
  })
})

describe('B9 C2 · structure and keyboard', () => {
  it('one labelled region with an "Analytics" heading, h2 for the two page blocks, h3 for each caption', async () => {
    const root = await mount()
    const region = within(root).getByTestId('analytics')
    expect(region.tagName).toBe('SECTION')
    expect(region.querySelector('#' + region.getAttribute('aria-labelledby'))?.textContent).toBe('Analytics')
    expect(Array.from(region.querySelectorAll('h2')).map((n) => n.textContent)).toEqual(['Analytics', 'Protocol performance', 'My Analytics'])
    expect(region.querySelector('h1')).toBeNull()
  })

  it('period tabs: ←/→/Home/End move and select (v1\'s four periods)', async () => {
    const root = await mount()
    const tabs = () => within(root).getAllByRole('tab')
    expect(tabs().map((t) => t.textContent)).toEqual(['All Time', '24H', '7D', '30D'])
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    tabs()[0].focus()
    fireEvent.keyDown(tabs()[0], { key: 'ArrowRight' })
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs()[1])
    expect(within(root).getByTestId('analytics-kpis').textContent).toContain('4 trades') // last24h
    fireEvent.keyDown(tabs()[1], { key: 'End' })
    expect(tabs()[3].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tabs()[3], { key: 'Home' })
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
  })

  it('Recent Activity: ↓ ↑ Home End walk the tx links (wrapping); Tab order stays native', async () => {
    const root = await mount()
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('[data-an-link]'))
    expect(links.length).toBeGreaterThanOrEqual(7)
    links[0].focus()
    fireEvent.keyDown(links[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(links[1])
    fireEvent.keyDown(links[1], { key: 'ArrowUp' })
    fireEvent.keyDown(links[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(links[links.length - 1])
    fireEvent.keyDown(links[links.length - 1], { key: 'Home' })
    expect(document.activeElement).toBe(links[0])
    fireEvent.keyDown(links[0], { key: 'End' })
    expect(document.activeElement).toBe(links[links.length - 1])
    for (const a of links) expect(a.getAttribute('aria-label')).toBe('View transaction')
  })
})

describe('B9 C2 · reduced motion', () => {
  it('no keyframes or animation; every transition is on a --t-* token, which tokens.css zeroes under prefers-reduced-motion', () => {
    expect(css).not.toMatch(/@keyframes|animation\s*:/)
    const transitions = css.match(/transition\s*:[^;]+;/g) ?? []
    expect(transitions.length).toBeGreaterThan(0)
    for (const t of transitions) expect(t).toMatch(/var\(--t-/)
    const block = tokens.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.ts-v2\s*\{[^}]*\}/)?.[0] ?? ''
    expect(block).toMatch(/--t-fast:0ms/)
  })

  it('the components set no inline animation or transition', () => {
    for (const f of ['AnalyticsTab.tsx', 'VolumeChart.tsx', 'PublicStats.tsx', 'PersonalStats.tsx']) {
      expect(readFileSync(join(DIR, f), 'utf8'), f).not.toMatch(/animate-|transition-|animation|framer-motion/)
    }
  })
})

describe('B9 C2 · 375', () => {
  it('the stylesheet collapses every grid to one column and stacks the activity rows at ≤ 700 px', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 700px)'))
    expect(mobile).toMatch(/\.ts-an-kpis[^{]*\.ts-an-cols\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/)
    expect(mobile).toMatch(/\.ts-an-act\s*\{[^}]*flex-direction:\s*column/)
    expect(mobile).toMatch(/\.ts-an-value\s*\{\s*font-size:\s*44px/)
  })

  it('nothing in the layout has a fixed width that cannot fit 343 px (only the 1200 px max-width)', () => {
    const widths = Array.from(css.matchAll(/(?<![-\w])(?:min-)?width\s*:\s*(\d+)px/g)).map((m) => Number(m[1]))
    expect(widths.filter((w) => w > 343)).toEqual([])
    expect(css).toMatch(/max-width:\s*1200px/)
  })

  it('every control keeps a 44 px hit area (tx link, Export CSV, period tabs)', async () => {
    expect(css).toMatch(/\.ts-an-act-link\s*\{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px/)
    expect(css).toMatch(/\.ts-an-action\s*\{[^}]*min-height:\s*44px/)
    const root = await mount()
    for (const t of within(root).getAllByRole('tab')) expect(t.className).toMatch(/min-h-\[44px\]/)
  })

  it('the personal block shows only for a connected wallet', async () => {
    h.connected = false
    const root = await mount()
    expect(within(root).queryByText('My Analytics')).toBeNull()
    expect(PERSONAL.totalSwaps).toBeGreaterThan(0)
    expect(DASHBOARD.recentTrades.length).toBeGreaterThan(10)
  })
})

describe('B9 C2 · AA text contrast on the page background', () => {
  const hex = (name: string) => tokens.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))![1]
  const lum = (c: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }
  it.each(['text', 'muted', 'dim', 'cream', 'teal', 'green', 'red', 'amber'])('--%s ≥ 4.5:1 on --bg', (name) => {
    expect(ratio(hex(name), hex('bg'))).toBeGreaterThanOrEqual(4.5)
  })
})
