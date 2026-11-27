// @vitest-environment jsdom
/**
 * [fix/quote-rate-limit-normal-use] The budget rule, as a test: normal use of the swap screen never sees "Rate limit
 * exceeded".
 *
 * The step 0 session, v1 and v2, at $100 and $10,000: the REAL SwapBox / SwapCard with the real hooks, each of their
 * /api/quote requests answered by the REAL route handler with the REAL limiter (30/min `quote:`, 66/min `quote-split:`)
 * and the real quote cache over an in-memory KV. Only the upstream fan-out (fetchMetaQuote) and the browser RPC are
 * stubs. The clock is fake.
 *
 * Owner's counting rule (2026-11-27): every action, in a limiter window of its own, makes fewer than 15 requests in the
 * minute from its first input (two tabs counted together); the whole back-to-back session gets no 429 at all.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fake: null as null | ReturnType<typeof import('@/test-utils/fake-kv').createFakeKv> }))
vi.mock('@/lib/kv', async () => {
  const { createFakeKv } = await import('@/test-utils/fake-kv')
  h.fake = createFakeKv()
  return { kv: h.fake.kv, kvRaw: h.fake.kv }
})

/** Two sources with a price impact that grows with size, so a split beats one source above the $5,000 threshold. */
vi.mock('@/lib/api', async () => {
  const PRICE: Record<string, [number, number]> = {
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee': [3000, 18],
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': [3000, 18],
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': [1, 6],
    '0xdac17f958d2ee523a2206206994597c13d831ec7': [1, 6],
    '0x6b175474e89094c44da98b954eedeac495271d0f': [1, 18],
  }
  const quote = (source: string, factor: number, src: string, dst: string, amount: string) => {
    const [pIn, dIn] = PRICE[src.toLowerCase()] ?? [10, 18]
    const [pOut, dOut] = PRICE[dst.toLowerCase()] ?? [10, 18]
    const usd = (Number(BigInt(amount)) / 10 ** dIn) * pIn
    const out = (usd / pOut) * factor * (1 - Math.min(0.2, usd * 4e-7))
    return { source, toAmount: ((BigInt(Math.floor(out * 1e6)) * 10n ** BigInt(dOut)) / 1_000_000n).toString(), estimatedGas: 150_000, gasUsd: 4, routes: [] }
  }
  return {
    ...(await vi.importActual<object>('@/lib/api')),
    fetchMetaQuote: async (src: string, dst: string, amount: string) => {
      const all = [quote('kyberswap', 1, src, dst, amount), quote('velora', 0.9995, src, dst, amount)]
      return { best: all[0], all, fetchedAt: Date.now() }
    },
  }
})
vi.mock('@/lib/rpc-guarded-transport', async () => (await import('@/test-utils/rpc-harness')).mockGuardedTransportModule())
vi.mock('@/components/BackgroundMusic', () => ({ default: () => null }))
vi.mock('@/lib/sounds', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/sounds')
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v]))
})
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/swap' }))
vi.mock('@/components/ParticleNetwork', () => ({ default: () => null, setParticleTurbo: vi.fn() }))

type Ui = 'v1' | 'v2'
interface Seen { at: number; status: number; split: boolean }
let seen: Seen[] = []
let clock = Date.now()

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  vi.stubEnv('RATE_LIMIT_SALT', 'budget-test-salt-budget-test-salt-budget-test')
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname !== '/api/quote') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    const entry: Seen = { at: Date.now(), status: 0, split: url.searchParams.get('split') === '1' }
    seen.push(entry)
    const { GET } = await import('@/app/api/quote/route')
    const response = await GET(new NextRequest(url, { headers: { 'x-real-ip': '203.0.113.50' } }))
    entry.status = response.status
    return response
  }))
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** In short steps, each its own act(): React runs effects when act() ends, and a timer an effect starts must start on time. */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(250, left)) })
  }
}

async function newWindow() {
  await import('@/lib/kv') // creates the fake on first use
  h.fake!.reset()
  ;(await import('@/lib/kv-rate-limiter'))._internal.reset()
  const cache = await import('@/lib/meta-quote-cache')
  cache._internal.localQuoteDampenerCache.clear()
  cache._internal.inFlightQuotes.clear()
}

/** One browser tab on the swap screen, driven the way a visitor drives it. */
async function openTab(ui: Ui) {
  const { default: Providers } = await import('@/app/providers')
  let tree: React.ReactNode
  if (ui === 'v1') {
    const { default: SwapBox } = await import('@/components/SwapBox')
    tree = <SwapBox />
  } else {
    const [{ SwapCard }, { V2ToastProvider }] = await Promise.all([import('@/ui/v2/swap/SwapCard'), import('@/ui/v2/shell/toasts')])
    tree = <V2ToastProvider><SwapCard /></V2ToastProvider>
  }
  let view!: ReturnType<typeof render>
  await act(async () => { view = render(<Providers>{tree}</Providers>) })
  const root = view.container
  const find = <T extends Element>(selector: string, where: ParentNode = root) => {
    const found = where.querySelector<T>(selector)
    if (!found) throw new Error(`${ui}: not found: ${selector}`)
    return found
  }
  const press = async (el: Element) => { await act(async () => { fireEvent.click(el) }) }
  const box = () => find<HTMLInputElement>(ui === 'v1' ? 'input[inputmode="decimal"]' : 'input[aria-label="Sell amount"]')
  const set = async (value: string) => { await act(async () => { fireEvent.change(box(), { target: { value } }) }) }
  const text = () => document.body.textContent ?? ''
  const flip = async () => {
    const button = ui === 'v1'
      ? [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === '⇅')
      : root.querySelector('button[aria-label="Swap sell and receive tokens"]')
    if (!button) throw new Error(`${ui}: no flip button`)
    await press(button)
  }
  const ADDRESS = { USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7', DAI: '0x6b175474e89094c44da98b954eedeac495271d0f' }
  const pickReceive = async (symbol: keyof typeof ADDRESS) => {
    if (ui === 'v1') {
      const trigger = [...root.querySelectorAll('button')].filter((b) => /(USDC|USDT|DAI)\s*▾$/.test(b.textContent?.trim() ?? '')).pop()
      if (!trigger) throw new Error('v1: no receive token button')
      await press(trigger)
      const search = find<HTMLInputElement>('input[placeholder^="Search name"]', document.body)
      await act(async () => { fireEvent.change(search, { target: { value: symbol } }) })
      const row = [...document.body.querySelectorAll('div.text-cream-gold')].find((d) => d.textContent === symbol)?.closest('button')
      if (!row) throw new Error(`v1: no row for ${symbol}`)
      await press(row)
    } else {
      await press(find('button[aria-label^="Receive token:"]'))
      const search = find<HTMLInputElement>('input[aria-label="Search name, symbol or paste address"]', document.body)
      await act(async () => { fireEvent.change(search, { target: { value: symbol } }) })
      const row = [...document.body.querySelectorAll<HTMLElement>('li[data-token]')].find((li) => li.dataset.token === ADDRESS[symbol])?.querySelector('button[data-token-row]')
      if (!row) throw new Error(`v2: no row for ${symbol}`)
      await press(row)
    }
  }
  return { ui, set, box, flip, pickReceive, text, unmount: () => view.unmount() }
}
type Tab = Awaited<ReturnType<typeof openTab>>

const digits = async (tab: Tab, value: string) => {
  for (let i = 1; i <= value.length; i++) {
    await tab.set(value.slice(0, i))
    await advance(700) // slower than the 500 ms debounce: every key is a settled amount
  }
}

/** The step 0 actions. `eth` is the ETH amount worth the session's size, `usd` the same in USDC. */
const ACTIONS: Record<string, (tab: Tab, size: { eth: string; usd: string }) => Promise<void | Tab>> = {
  idle: async () => { await advance(60_000) },
  token5: async (tab) => { for (const symbol of ['USDT', 'DAI', 'USDC', 'USDT', 'USDC'] as const) { await tab.pickReceive(symbol); await advance(6_000) } },
  typed: async (tab, { eth }) => { await tab.set(''); await digits(tab, eth); await advance(8_000) },
  flip: async (tab, { eth, usd }) => {
    await tab.flip(); await advance(2_000)
    await tab.set(''); await digits(tab, usd); await advance(8_000)
    await tab.flip(); await advance(2_000)
    await tab.set(eth); await advance(6_000)
  },
  // a large amount deleted down to a small one, key by key (USDC in: the typed number is the USD value)
  backspace: async (tab, { eth }) => {
    await tab.flip(); await advance(2_000)
    await tab.set('1234567'); await advance(8_000)
    for (const shorter of ['123456', '12345', '1234', '123', '12']) { await tab.set(shorter); await advance(700) }
    await advance(8_000)
    await tab.flip(); await advance(2_000)
    await tab.set(eth); await advance(6_000)
  },
  // a quoted 3.3333 ETH replaced by a small amount typed faster than the debounce (v1's other way into the limit)
  replaceFast: async (tab, { eth }) => {
    await tab.set('3.3333'); await advance(8_000)
    for (const typed of ['3.333', '3.33', '3.3', '3.', '3', '', '0', '0.', '0.0', '0.01', '0.012', '0.0123']) { await tab.set(typed); await advance(150) }
    await advance(8_000)
    await tab.set(eth); await advance(6_000)
  },
  twoTabs: async (tab, { eth }) => {
    const second = await openTab(tab.ui)
    await second.set(eth)
    await advance(60_000)
    return second
  },
}

const SIZES = { $100: { eth: '0.0333', usd: '100' }, '$10,000': { eth: '3.3333', usd: '10000' } }
/** "Under 15 /api/quote requests a minute." */
const BUDGET = 14

function startClock() {
  clock += 10 * 60_000
  vi.useFakeTimers({ now: clock, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}

const report: string[] = []
afterAll(() => {
  if (process.env.QUOTE_BUDGET_TABLE) console.log(`\nQUOTE BUDGET\n${report.join('\n')}\n`)
})

describe.each(['v1', 'v2'] as Ui[])('quote budget, step 0 session: %s', (ui) => {
  it.each(Object.keys(SIZES) as (keyof typeof SIZES)[])('at %s every action stays under 15 requests a minute, with no 429', async (label) => {
    const size = SIZES[label]
    const rows: { action: string; requests: number; refused: number; split: number }[] = []
    for (const [action, run] of Object.entries(ACTIONS)) {
      await newWindow()
      startClock()
      const tab = await openTab(ui)
      await tab.set(size.eth)
      await advance(8_000)
      expect(seen.length, 'the screen really quotes').toBeGreaterThan(0)
      seen = []
      const started = Date.now()
      const extra = await run(tab, size)
      await advance(Math.max(0, started + 60_000 - Date.now()))
      const minute = seen.filter((r) => r.at - started < 60_000)
      rows.push({ action, requests: minute.length, refused: seen.filter((r) => r.status === 429).length, split: seen.filter((r) => r.split).length })
      expect(tab.text(), `${action}: no rate-limit message`).not.toMatch(/rate limit exceeded/i)
      if (extra) extra.unmount()
      tab.unmount()
      clock = Date.now()
      vi.useRealTimers()
      seen = []
    }
    report.push(`${ui} ${label}: ${rows.map((r) => `${r.action}=${r.requests}/${r.refused}429/${r.split}split`).join('  ')}`)
    expect(rows.filter((r) => r.requests > BUDGET || r.refused > 0)).toEqual([])
    // Not a pass by silence: at $10,000 the split analysis really ran; at $100 nothing idle ever asked for one.
    const idle = rows.find((r) => r.action === 'idle')!
    expect(idle.requests, 'idle still refreshes the quote every 15 s').toBeGreaterThanOrEqual(4)
    if (label === '$100') expect(idle.split).toBe(0)
    else expect(idle.split).toBeGreaterThanOrEqual(3)
  }, 240_000)

  it.each(Object.keys(SIZES) as (keyof typeof SIZES)[])('at %s the whole back-to-back session gets no 429', async (label) => {
    const size = SIZES[label]
    await newWindow()
    startClock()
    seen = []
    const tab = await openTab(ui)
    await tab.set(size.eth)
    await advance(8_000)
    const tabs: Tab[] = []
    for (const run of Object.values(ACTIONS)) {
      const extra = await run(tab, size)
      if (extra) tabs.push(extra)
    }
    expect(seen.length).toBeGreaterThan(30)
    expect(seen.filter((r) => r.status !== 200).map((r) => r.status)).toEqual([])
    expect(tab.text()).not.toMatch(/rate limit exceeded/i)
    for (const t of [tab, ...tabs]) t.unmount()
    clock = Date.now()
    vi.useRealTimers()
    seen = []
  }, 240_000)
})
