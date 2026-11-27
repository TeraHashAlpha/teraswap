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
import { parseUnits } from 'viem'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  fake: null as null | ReturnType<typeof import('@/test-utils/fake-kv').createFakeKv>,
  /** false: no price impact, so no split ever beats the best single source and none is ever selected. */
  impact: true,
  /** When set, the fan-out of this raw amount (the screen's own) takes 0.3 s and every other amount's takes 2.5 s. */
  slowSubsOf: null as string | null,
}))
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
    const out = (usd / pOut) * factor * (1 - (h.impact ? Math.min(0.2, usd * 4e-7) : 0))
    return { source, toAmount: ((BigInt(Math.floor(out * 1e6)) * 10n ** BigInt(dOut)) / 1_000_000n).toString(), estimatedGas: 150_000, gasUsd: 4, routes: [] }
  }
  return {
    ...(await vi.importActual<object>('@/lib/api')),
    fetchMetaQuote: async (src: string, dst: string, amount: string) => {
      const slow = h.slowSubsOf
      if (slow !== null) await new Promise((resolve) => setTimeout(resolve, amount === slow ? 300 : 2_500))
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
/** `poll`: the swap screen's own quote request (useQuote can abort it; the split hook's own request passes no signal). */
interface Seen { at: number; status: number; split: boolean; poll: boolean; ms: number }
let seen: Seen[] = []
let clock = Date.now()

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  vi.stubEnv('RATE_LIMIT_SALT', 'budget-test-salt-budget-test-salt-budget-test')
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname !== '/api/quote') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    const entry: Seen = { at: Date.now(), status: 0, split: url.searchParams.get('split') === '1', poll: !!init?.signal, ms: -1 }
    seen.push(entry)
    const { GET } = await import('@/app/api/quote/route')
    const response = await GET(new NextRequest(url, { headers: { 'x-real-ip': '203.0.113.50' } }))
    entry.status = response.status
    entry.ms = Date.now() - entry.at
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
  h.impact = true
  h.slowSubsOf = null
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
  /** The split switch as the visitor sees it: null while no split panel is on screen. */
  const splitSwitch = (): { on: boolean; el: Element } | null => {
    if (ui === 'v2') {
      const el = root.querySelector('[data-testid="split-route"] button[role="switch"]')
      return el ? { on: el.getAttribute('aria-checked') === 'true', el } : null
    }
    const el = root.querySelector('button[title="Disable split routing"], button[title="Enable split routing"]')
    return el ? { on: el.getAttribute('title') === 'Disable split routing', el } : null
  }
  return { ui, set, box, flip, pickReceive, text, press, splitSwitch, unmount: () => view.unmount() }
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

/** One tab on the swap screen with a $10,000 amount entered, its first quote and analysis in. */
async function tradingTab(ui: Ui) {
  await newWindow()
  startClock()
  seen = []
  const tab = await openTab(ui)
  await tab.set(SIZES['$10,000'].eth)
  await advance(8_000)
  return tab
}
function closeTabs(...tabs: Tab[]) {
  for (const t of tabs) t.unmount()
  clock = Date.now()
  vi.useRealTimers()
  seen = []
}

/**
 * [fix/quote-split-followups] A108 S-1 and the audit's pre-existing list.
 */
describe.each(['v1', 'v2'] as Ui[])('with no split selected: %s', (ui) => {
  beforeAll(async () => {
    await import('@/app/api/quote/route') // so the first measured wait is not the module loading
  })

  it('every step 0 action at $10,000 stays under 15 requests a minute with no 429, and no quote poll carries the split', async () => {
    h.impact = false
    const over: unknown[] = []
    let carried = 0
    let analyses = 0
    for (const [action, run] of Object.entries(ACTIONS)) {
      const tab = await tradingTab(ui)
      expect(tab.splitSwitch()?.on ?? false, 'nothing is selected').toBe(false)
      seen = []
      const started = Date.now()
      const extra = await run(tab, SIZES['$10,000'])
      // three minutes in all, so the once-a-minute refresh really comes round
      await advance(Math.max(0, started + 180_000 - Date.now()))
      for (let minute = 0; minute < 3; minute++) {
        const inIt = seen.filter((r) => r.at - started >= minute * 60_000 && r.at - started < (minute + 1) * 60_000)
        if (inIt.length > BUDGET) over.push({ action, minute, requests: inIt.length })
      }
      over.push(...seen.filter((r) => r.status === 429).map(() => ({ action, status: 429 })))
      carried += seen.filter((r) => r.poll && r.split).length
      analyses += seen.filter((r) => !r.poll && r.split).length
      closeTabs(...(extra ? [extra, tab] : [tab]))
    }
    expect(over).toEqual([])
    expect(carried, 'quote polls that carried the split').toBe(0)
    expect(analyses, 'the refresh still happens, as a request of its own').toBeGreaterThan(8)
  }, 240_000)

  it('the quote poll answers in the main quote\'s own 0.3 s while the sub-quotes take 2.5 s', async () => {
    h.impact = false
    h.slowSubsOf = parseUnits(SIZES['$10,000'].eth, 18).toString()
    const tab = await tradingTab(ui)
    await advance(160_000)
    const polls = seen.filter((r) => r.poll && r.ms >= 0)
    expect(polls.length).toBeGreaterThan(10)
    expect(polls.map((r) => r.ms)).toEqual(polls.map(() => 300))
    const own = seen.filter((r) => !r.poll && r.split && r.ms >= 0)
    expect(own.length, 'analysed, then refreshed twice').toBeGreaterThanOrEqual(3)
    expect(own.slice(1).every((r) => r.ms === 2_500), 'the sub-quotes really were slow').toBe(true)
    closeTabs(tab)
  }, 240_000)
})

describe.each(['v1', 'v2'] as Ui[])('the split switch and its badge: %s', (ui) => {
  it('switched off by hand it stays off for that pair and amount; a new amount or token selects it again', async () => {
    const tab = await tradingTab(ui)
    expect(tab.splitSwitch()?.on).toBe(true)
    await tab.press(tab.splitSwitch()!.el)
    expect(tab.splitSwitch()?.on).toBe(false)
    seen = []
    await advance(170_000)
    expect(seen.filter((r) => r.split && r.status === 200).length, 'it really was analysed again').toBeGreaterThanOrEqual(2)
    expect(tab.splitSwitch()?.on).toBe(false)

    await tab.set('4')
    await advance(8_000)
    expect(tab.splitSwitch()?.on).toBe(true)

    await tab.press(tab.splitSwitch()!.el)
    await tab.pickReceive('USDT')
    await advance(8_000)
    expect(tab.splitSwitch()?.on).toBe(true)
    closeTabs(tab)
  }, 240_000)

  it('the badge shows its improvement with one percent sign', async () => {
    const tab = await tradingTab(ui)
    expect(tab.splitSwitch()).not.toBeNull()
    expect(tab.text()).toMatch(/\+\d+(\.\d+)?%/)
    expect(tab.text()).not.toContain('%%')
    closeTabs(tab)
  }, 240_000)
})

describe.each(['v1', 'v2'] as Ui[])('a spent quote window: %s', (ui) => {
  it('recovers when the real limiter says it frees, about 60 s later, and the wait on screen says so', async () => {
    await newWindow()
    startClock()
    seen = []
    const { GET } = await import('@/app/api/quote/route')
    const other = 'src=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&dst=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48&amount=1000000000000000000&srcDecimals=18&dstDecimals=6'
    const spend = () => GET(new NextRequest(`http://localhost/api/quote?${other}`, { headers: { 'x-real-ip': '203.0.113.50' } }))
    for (let i = 0; i < 30; i++) expect((await spend()).status).toBe(200)
    const tab = await openTab(ui)
    await tab.set(SIZES.$100.eth)
    await advance(1_000)
    expect(seen.map((r) => r.status)).toEqual([429])
    const shown = Number(/Retrying in (\d+)s/.exec(tab.text())?.[1])
    expect(shown).toBeGreaterThanOrEqual(59)
    expect(shown).toBeLessThanOrEqual(61)
    await advance(61_000)
    expect(seen.map((r) => r.status)).toEqual([429, 200])
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(59_000)
    expect(seen[1].at - seen[0].at).toBeLessThanOrEqual(61_000)
    // the card: its countdown is gone and the quote is there (jsdom keeps the earlier toast's node, so not "no message")
    expect(tab.text()).not.toMatch(/retrying in/i)
    expect(tab.text()).toContain('Best via')
    closeTabs(tab)
  }, 240_000)
})
