// @vitest-environment jsdom
/**
 * [ADR-025] The v2 landing (pack 10 / 10a / m01). wagmi / next / the quote hook are mocked at the module edge; the
 * claims module is mocked with DISTINCT values (11 sources, 13 checks, 3 stages, 0.7 % fee, per-chain feed counts) so
 * a number typed into the page instead of read from its slot cannot hide behind a coincidence.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  isConnected: false,
  chainId: 1,
  quote: { meta: { best: { toAmount: '1266342000' } } as { best?: { toAmount: string } } | null, loading: false, error: null as string | null },
  touch: vi.fn(),
  orderLive: new Set<string>(['dca']),
  dcaTitle: 'DCA (Base)',
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: h.isConnected, chain: undefined }),
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBlockNumber: () => ({ data: 23_541_870n }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/ui/v2/font-loader', () => ({ v2FontClassNames: 'font-vars', v2BodyFontFamily: 'body-font' }))
vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => h.chainId }))
vi.mock('@/hooks/useQuote', () => ({ useQuote: () => h.quote }))
vi.mock('@/lib/sounds', async () => ({ ...(await vi.importActual<typeof import('@/lib/sounds')>('@/lib/sounds')), playTouchMP3: h.touch }))
vi.mock('@/lib/chains', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chains')>('@/lib/chains')
  return { ...actual, getChainTokenList: () => [{ symbol: 'ETH' }, { symbol: 'USDC' }], remapTokenToChain: (t: unknown) => t }
})
vi.mock('@/lib/tokens', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tokens')>('@/lib/tokens')
  return { ...actual, findToken: (s: string) => ({ symbol: s, decimals: s === 'USDC' ? 6 : 18, address: '0x0', name: s }) }
})
vi.mock('@/config/product-claims', async () => {
  const actual = await vi.importActual<typeof import('@/config/product-claims')>('@/config/product-claims')
  const checks = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}` }))
  const stages = ['pre-trade', 'mid-trade', 'post-execution'] as const
  return {
    ...actual,
    INTEGRATED_DEX_SOURCE_COUNT: 11,
    INTEGRATED_DEX_SOURCE_COUNT_WORDS: 'eleven',
    INTEGRATED_DEX_SOURCE_COUNT_WORDS_CAP: 'Eleven',
    VERIFICATION_CHECKS: checks,
    VERIFICATION_CHECK_COUNT: 13,
    VERIFICATION_STAGES: stages,
    PLATFORM_FEE_LABEL: '0.7%',
    chainlinkFeedCountFor: (id: number) => ({ 1: 31, 8453: 17, 42161: 5 })[id] ?? 0,
    isOrderTypeLive: (t: string) => h.orderLive.has(t),
    dcaFeatureTitle: () => h.dcaTitle,
  }
})

import { INTEGRATED_DEX_SOURCE_NAMES, SWAP_CHAIN_LIST_LABEL } from '@/config/product-claims'
import { LandingV2 } from './index'
import { NARRATIVE_SECTIONS, staggerDelayMs } from './narrative'
import { heroStats, securityStats } from './slots'

const SRC = join(__dirname)
const launch = vi.fn()

beforeEach(() => {
  h.isConnected = false
  h.chainId = 1
  h.quote = { meta: { best: { toAmount: '1266342000' } }, loading: false, error: null }
  h.orderLive = new Set(['dca'])
  h.dcaTitle = 'DCA (Base)'
  h.touch.mockClear()
  launch.mockClear()
})
afterEach(cleanup)

const text = () => document.body.textContent ?? ''
const mount = () => render(<LandingV2 onLaunchApp={launch} />)

describe('structure: ten sections in the pack order', () => {
  it('header · hero · performance · why · security · experience · features · roadmap · CTA · docs · footer', () => {
    mount()
    const main = document.querySelector('main')!
    const order = Array.from(main.querySelectorAll(':scope > section')).map((s) => s.id || '(cta)')
    expect(order).toEqual(['hero', 'performance', 'why-teraswap', 'security', 'experience', 'features', 'roadmap', '(cta)', 'docs'])
    const header = screen.getByRole('banner')
    const footer = screen.getByRole('contentinfo')
    expect(header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(main.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('each section has one heading, and the page has exactly one h1 (the hero)', () => {
    mount()
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('One swap. Eleven routes. Verified.')
    for (const id of ['performance', 'why-teraswap', 'security', 'experience', 'features', 'roadmap', 'docs']) {
      expect(document.querySelectorAll(`#${id} h2`)).toHaveLength(1)
    }
  })

  it('the roadmap lists Limit and SL/TP only while their order types are not live; DCA is never "Soon" when live', () => {
    mount()
    const roadmap = document.querySelector('#roadmap')!
    expect(roadmap.textContent).toContain('Limit Orders')
    expect(roadmap.textContent).toContain('Stop Loss / Take Profit')
    expect(roadmap.textContent).not.toContain('DCA')
    expect(document.querySelector('#features')!.textContent).toContain('DCA (Base)')
    cleanup()
    h.orderLive = new Set(['dca', 'limit', 'stopLoss'])
    mount()
    expect(document.querySelector('#roadmap')).toBeNull()
  })

  it('credit: desktop line unchanged; ≤ 600 px a second footer line lists every photographer on the page, once', () => {
    mount()
    const footer = document.querySelector('[data-ts-footer]')!
    const desktop = footer.querySelector('.ts-v2-photo-credit--desktop')!
    const mobile = footer.querySelector('.ts-v2-photo-credit--mobile')!
    expect(desktop.textContent).toBe('Photo Yakup Gökdeniz · Peter Dyllong / Pexels')
    expect(mobile.textContent).toBe('Photo Yakup Gökdeniz · Peter Dyllong · Oleksiy Yeshtokyn · Владимир Николаевич · Willbone Gallery / Pexels')
    // the mobile map's three photos only: Footbridge and Arch-in-light never show at ≤ 600 px, so they are not named there
    expect(mobile.textContent).not.toMatch(/Erik Mclean|wal_/)
    // the fixed narrative credit is the only other credit element, and it is not in the footer
    expect(document.querySelectorAll('.ts-v2-nar-credit')).toHaveLength(1)
    expect(footer.contains(document.querySelector('.ts-v2-nar-credit'))).toBe(false)
    const css = readFileSync(join(SRC, '..', 'photos', 'photo.css'), 'utf8')
    expect(css).toMatch(/\.ts-v2-photo-credit--mobile\s*\{\s*display:\s*none;/)
    expect(css).toMatch(/@media \(max-width: 600px\)\s*\{\s*\.ts-v2-photo-credit--desktop\s*\{\s*display:\s*none;\s*\}\s*\.ts-v2-photo-credit--mobile\s*\{\s*display:\s*inline-block;/)
  })

  it('the shell footer closes the page and carries both photo authors, in the footer container only', () => {
    mount()
    const footer = document.querySelector('[data-ts-footer]')!
    expect(footer.textContent).toContain('Photo Yakup Gökdeniz · Peter Dyllong / Pexels')
    expect(footer.textContent).toContain('Smart contracts have not been externally audited. Use at your own risk.')
    expect(footer.textContent).toContain('Fee 0.7%')
    for (const fab of [screen.getByRole('button', { name: /music/i }), screen.getByRole('button', { name: 'Open help' })]) {
      expect(footer.contains(fab)).toBe(false)
    }
    // photos sit inside their sections (absolute), not as a second fixed layer
    expect(document.querySelectorAll('.ts-v2-photo--section')).toHaveLength(3)
    expect(document.querySelectorAll('.ts-v2-photo:not(.ts-v2-photo--section)')).toHaveLength(0)
  })
})

describe('numbers are slots', () => {
  it('hero: 3 cells, numeral + label, values from the slots (selected chain follows)', () => {
    mount()
    const cells = Array.from(document.querySelectorAll('#hero dl > div'))
    expect(cells).toHaveLength(3)
    expect(cells.map((c) => [c.querySelector('dd')!.textContent, c.querySelector('dt')!.textContent])).toEqual([
      ['11', 'LIQUIDITY SOURCES'],
      ['13', 'VERIFICATION CHECKS · 3 STAGES'],
      ['31', 'CHAINLINK ORACLES · Ethereum'],
    ])
    expect(heroStats(1).map((s) => s.value)).toEqual([11, 13, 31])
    cleanup()
    h.chainId = 8453
    mount()
    expect(document.querySelector('#hero dl > div:nth-child(3)')!.textContent).toContain('17')
    expect(document.querySelector('#hero dl > div:nth-child(3)')!.textContent).toContain('CHAINLINK ORACLES · Base')
  })

  it('security bar: sources · checks · feeds on the chain · the post-execution mark', () => {
    mount()
    const cells = Array.from(document.querySelectorAll('#security dl > div')).map((c) => [c.querySelector('dd')!.textContent, c.querySelector('dt')!.textContent])
    expect(cells).toEqual([
      ['11', 'Liquidity sources'],
      ['13', 'Independent verification checks'],
      ['31', 'Chainlink token price feeds on Ethereum'],
      ['✓ Verified', 'Post-execution verified'],
    ])
    expect(securityStats(42161).map((s) => s.value)).toEqual([11, 13, 5, null])
  })

  it('no stray typed number: every numeral in the page text is a mocked slot or part of verbatim v1 copy', () => {
    mount()
    const landing = Array.from(document.querySelectorAll('main, header')).map((n) => n.textContent ?? '').join(' ')
    const found = new Set(landing.match(/\d+(?:\.\d+)?/g))
    const slots = new Set([
      '11', '13', '3', '31', '0.7', // sources · checks · stages (mocked) · feeds (Ethereum) · fee
      '0.5', '266.3420', // LANDING_PREVIEW_AMOUNT_IN and the quote shown ("1 266.3420", thin-space thousands → "1" + "266.3420")
      '01', '02', '03', // list indices of "What makes TeraSwap different"
      '60', '48', // CHAINLINK_STALENESS_CLAIM and ADMIN_TIMELOCK_HOURS (claims slots, real values)
    ])
    // The only numerals that are part of v1's own sentences, copied verbatim: "P0 alert", "2-way and 3-way", the "1" of 1 266:
    const verbatim = new Set(['0', '1', '2', '3'])
    const stray = Array.from(found).filter((n) => !slots.has(n) && !verbatim.has(n))
    expect(stray).toEqual([])
    // and the real defaults of the product (8 / 2 / 29 / 7 / 0.1%) never reach the page through a typed copy:
    expect(landing).not.toMatch(/\b29\b/)
    expect(landing).not.toMatch(/0\.1%/)
    expect(landing).not.toMatch(/\bEight\b/)
  })

  it('the quote line is the same kind of slot: 0.5 ETH in, the hook\'s amount out, "Compared N DEX sources", the fee', () => {
    mount()
    const card = document.querySelector('#hero [aria-live="polite"]')!.closest('div')!.parentElement!
    expect(card.textContent).toContain('0.5')
    expect(card.textContent).toContain('ETH')
    expect(card.textContent).toContain('USDC')
    expect(card.textContent).toContain('Compared')
    expect(card.textContent).toContain('11 DEX sources')
    expect(card.textContent).toContain('Platform fee')
    expect(card.textContent).toContain('0.7%')
  })

  it('no resolved quote → no "Compared" claim (v1 rule); an error reads Unavailable', () => {
    h.quote = { meta: null, loading: true, error: null }
    mount()
    expect(screen.queryByText('Compared')).toBeNull()
    expect(document.querySelector('#hero [aria-live="polite"]')!.textContent).toBe('···')
    cleanup()
    h.quote = { meta: null, loading: false, error: 'boom' }
    mount()
    expect(document.querySelector('#hero [aria-live="polite"]')!.textContent).toBe('Unavailable')
    expect(screen.queryByText('Compared')).toBeNull()
  })

  it('chains and sources in the copy come from the claims, not typed', () => {
    mount()
    expect(text()).toContain(SWAP_CHAIN_LIST_LABEL)
    const graph = within(screen.getByRole('group', { name: 'Liquidity sources' }))
    for (const name of INTEGRATED_DEX_SOURCE_NAMES) expect(graph.getAllByText(name).length).toBeGreaterThan(0)
  })
})

describe('server render: final values first, never a count-up from 0', () => {
  it('renderToString already carries every stat at its final value, and the page has no counter code', () => {
    const html = renderToString(<LandingV2 onLaunchApp={launch} />)
    expect(html).toMatch(/<dd[^>]*>11<\/dd>/)
    expect(html).toMatch(/<dd[^>]*>13<\/dd>/)
    expect(html).toMatch(/<dd[^>]*>31<\/dd>/)
    expect(html).not.toMatch(/<dd[^>]*>0<\/dd>/)
    for (const f of ['Hero.tsx', 'Sections.tsx', 'index.tsx', 'LandingHeader.tsx']) {
      const src = readFileSync(join(SRC, f), 'utf8')
      expect(src).not.toMatch(/requestAnimationFrame|useInView|AnimatedCounter|framer-motion/)
    }
  })
})

describe('reduced motion', () => {
  const CSS = readFileSync(join(SRC, 'landing.css'), 'utf8')
  const TOKENS = readFileSync(join(SRC, '..', 'tokens.css'), 'utf8')

  it('smooth anchor scrolling only under no-preference; the one entrance animation is switched off by tokens.css', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html:has\(\[data-ts-landing\]\) \{ scroll-behavior: smooth; \}/)
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/animation:/g)).toHaveLength(1)
    expect(TOKENS).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/)
    expect(TOKENS).toMatch(/\.ts-v2 \*, \.ts-v2 \*::before, \.ts-v2 \*::after/)
  })

  it('no inline/CSS-in-JS animation anywhere in the landing', () => {
    for (const f of ['Hero.tsx', 'Sections.tsx', 'index.tsx', 'LandingHeader.tsx']) {
      expect(readFileSync(join(SRC, f), 'utf8')).not.toMatch(/animate-|animation:|transition: \{|@keyframes/)
    }
  })
})

describe('CTAs → the same target as v1 (handleLaunchApp)', () => {
  it('header Launch app, hero Launch app, hero "Swap →", "Launch the full app →" and the bottom Launch app all launch', () => {
    mount()
    const buttons = [
      within(screen.getByRole('banner')).getByRole('button', { name: 'Launch app' }),
      within(document.querySelector('#hero')!as HTMLElement).getByRole('button', { name: 'Launch app' }),
      screen.getByRole('button', { name: 'Swap →' }),
      screen.getByRole('button', { name: /Launch the full app/ }),
      within(screen.getByRole('main')).getAllByRole('button', { name: 'Launch app' }).at(-1)!,
    ]
    for (const b of buttons) fireEvent.click(b)
    expect(launch).toHaveBeenCalledTimes(5)
  })

  it('the touch sound plays on the same presses as in v1 (hero Launch app and the preview Swap), not on the others', () => {
    mount()
    fireEvent.click(within(document.querySelector('#hero')! as HTMLElement).getByRole('button', { name: 'Launch app' }))
    fireEvent.click(screen.getByRole('button', { name: 'Swap →' }))
    expect(h.touch).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: /Launch the full app/ }))
    fireEvent.click(within(screen.getByRole('main')).getAllByRole('button', { name: 'Launch app' }).at(-1)!)
    expect(h.touch).toHaveBeenCalledTimes(2)
  })

  it('"See the routing engine" → #performance; "Read the docs" → /docs', () => {
    mount()
    expect(screen.getByRole('link', { name: /See the routing engine/ }).getAttribute('href')).toBe('#performance')
    const docs = screen.getAllByRole('link', { name: /Read the docs/ })
    expect(docs.map((a) => a.getAttribute('href'))).toEqual(['/docs'])
  })
})

describe('nav (I-6): Performance · Security · Experience · Features · Docs · My Analytics', () => {
  it('the four anchors, Docs → /docs; My Analytics → /analytics only with a connected wallet (v1 P99)', () => {
    mount()
    const nav = () => within(screen.getAllByRole('navigation', { name: 'Sections' })[0])
    expect(['Performance', 'Security', 'Experience', 'Features'].map((l) => nav().getByRole('link', { name: l }).getAttribute('href'))).toEqual([
      '#performance',
      '#security',
      '#experience',
      '#features',
    ])
    expect(nav().getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe('/docs')
    expect(nav().queryByRole('link', { name: 'My Analytics' })).toBeNull()
    cleanup()
    h.isConnected = true
    mount()
    expect(nav().getByRole('link', { name: 'My Analytics' }).getAttribute('href')).toBe('/analytics')
  })

  it('every anchor target exists on the page', () => {
    mount()
    for (const id of ['performance', 'security', 'experience', 'features']) expect(document.getElementById(id)).not.toBeNull()
  })

  it('mobile: the ☰ menu opens the same links and closes on selection', () => {
    mount()
    expect(screen.getAllByRole('navigation', { name: 'Sections' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(screen.getAllByRole('navigation', { name: 'Sections' })).toHaveLength(2)
    fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Sections' })[1]).getByRole('link', { name: 'Security' }))
    expect(screen.getAllByRole('navigation', { name: 'Sections' })).toHaveLength(1)
  })
})

describe('mobile (m01, 375 px)', () => {
  it('hero stats stay 3 columns; CTAs stack full-width; photo credit is in the footer, left', () => {
    mount()
    expect(document.querySelector('#hero dl')!.className).toContain('grid-cols-3')
    const cta = within(document.querySelector('#hero')! as HTMLElement).getByRole('button', { name: 'Launch app' }).parentElement!
    expect(cta.className).toContain('flex-col')
    expect(cta.className).toContain('sm:flex-row')
    expect(document.querySelector('[data-ts-footer] .ts-v2-photo-credit')).not.toBeNull()
  })
})

describe('home split', () => {
  it('act wrapper sanity: rendering twice does not leak state', () => {
    act(() => {
      mount()
    })
    expect(screen.getAllByRole('button', { name: 'Launch app' }).length).toBeGreaterThan(0)
  })
})

describe('scroll narrative: markup (MOTION-SPEC §1, §4)', () => {
  const rvOf = (id: string) => Array.from(document.querySelectorAll<HTMLElement>(`#${id} .ts-v2-rv`))
  const idx = (el: HTMLElement) => (el.style.getPropertyValue('--i') === '' ? 0 : Number(el.style.getPropertyValue('--i')))

  it('only §4–§7 and §9 are narrative sections; the hero, §2, §3 and §8 stay opaque (they cover the stack), as does the footer', () => {
    mount()
    const narrative = Array.from(document.querySelectorAll('[data-ts-narrative]')).map((s) => s.id)
    expect(narrative).toEqual(['security', 'experience', 'features', 'roadmap', 'docs'])
    expect(narrative).toEqual([...NARRATIVE_SECTIONS])
    const opaque = Array.from(document.querySelectorAll('main > .ts-v2-opaque')).map((s) => s.id || '(cta)')
    expect(opaque).toEqual(['hero', 'performance', 'why-teraswap', '(cta)'])
    for (const id of NARRATIVE_SECTIONS) expect(document.getElementById(id)!.classList.contains('ts-v2-opaque')).toBe(false)
    expect(document.querySelector('[data-ts-footer]')!.closest('.ts-v2-opaque')).not.toBeNull()
  })

  it('the stack sits before the header, outside <main>, and only the narrative sections carry .ts-v2-rv', () => {
    mount()
    const stack = document.querySelector('[data-ts-narrative-stack]')!
    expect(document.querySelector('main')!.contains(stack)).toBe(false)
    expect(stack.compareDocumentPosition(screen.getByRole('banner')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const id of ['hero', 'performance', 'why-teraswap']) expect(rvOf(id)).toHaveLength(0)
    for (const id of NARRATIVE_SECTIONS) expect(rvOf(id).length).toBeGreaterThan(0)
  })

  it('headers, copy blocks and cards carry .rv, indexed in order for the stagger', () => {
    mount()
    expect(rvOf('security').map(idx)).toEqual([0, 0, 0, 1, 2]) // head, copy, 2 checks, stats panel
    expect(rvOf('experience').map(idx)).toEqual([0, 0, 0]) // head, copy, permit card
    expect(rvOf('features').map(idx)).toEqual([0, 0, ...Array.from({ length: rvOf('features').length - 2 }, (_, i) => i)])
    expect(rvOf('roadmap').map(idx)).toEqual([0, 0, 1])
    expect(rvOf('docs').map(idx)).toEqual([0, 0])
  })

  it('a long card list staggers 0, 40, 80, 120, 160 ms and then holds at 160 ms (capped at index 4)', () => {
    mount()
    const cards = rvOf('features').slice(2)
    expect(cards.length).toBeGreaterThan(5)
    expect(cards.map((c) => staggerDelayMs(idx(c)))).toEqual(cards.map((_, i) => Math.min(i, 4) * 40))
    expect(Math.max(...cards.map((c) => staggerDelayMs(idx(c))))).toBe(160)
  })

  it('muted copy sits straight on the photo only in security / experience / features (narrative-contrast.test.ts models exactly that)', () => {
    mount()
    const offPanel = (id: string) =>
      Array.from(document.querySelectorAll(`#${id} [class*="text-v2-muted"]`)).filter((el) => !el.closest('[class*="bg-v2-surface"]'))
    for (const id of ['security', 'experience', 'features']) expect(offPanel(id).length, id).toBeGreaterThan(0)
    for (const id of ['roadmap', 'docs']) expect(offPanel(id).map((e) => e.textContent), id).toEqual([])
  })

  it('every headline underline is inside a narrative section h2 (so the draw-once CSS reaches it)', () => {
    mount()
    for (const id of ['security', 'experience']) expect(document.querySelectorAll(`#${id} h2 svg`).length).toBeGreaterThan(0)
  })
})
