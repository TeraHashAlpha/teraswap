// @vitest-environment jsdom
/**
 * [fix/user-ip-privacy] The Privacy Policy (§3.2, §5, §8), the Docs "Privacy" section and the Help answers say what is
 * relayed and what is not — the same sentences in v1 and v2 — and no longer say the three things that were not true:
 * "we do not collect or store your … IP address" (as an absolute), "your browser never makes direct requests", and
 * "we do not employ any third-party analytics … scripts".
 *
 * The five sentences are the owner's wording (product-claims.ts). Here they are checked where a reader meets them.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

vi.mock('@/hooks/useChainId', () => ({ useQuoteChainId: () => 1 }))

beforeAll(() => {
  window.scrollTo = (() => {}) as typeof window.scrollTo
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO
})

import LegalPage from '@/components/LegalPage'
import DocsPage from '@/components/DocsPage'
import { LegalPageV2 } from './LegalPageV2'
import { DocsTabV2 } from './DocsTabV2'
import {
  PRIVACY_DIRECT_NOTE,
  PRIVACY_IP_STORAGE_NOTE,
  PRIVACY_PROXY_CLAIM,
  PRIVACY_WALLET_ADVICE,
  PRIVACY_WALLET_STORAGE_NOTE,
} from '@/config/product-claims'

afterEach(cleanup)

/** Visible text with whitespace collapsed (JSX line breaks are not sentence breaks). */
const textOf = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The text of one Privacy Policy section: from its heading up to the next section heading. */
function section(container: HTMLElement, id: string): string {
  const heading = container.querySelector(`#${id}`)
  expect(heading, `section #${id}`).not.toBeNull()
  const parts: string[] = []
  for (let el = heading!.nextElementSibling; el && !/^pp-|^tos-/.test(el.id); el = el.nextElementSibling) parts.push(textOf(el))
  return parts.join(' ')
}

const LEGAL = [
  ['v1', () => render(<LegalPage type="privacy" />).container],
  ['v2', () => render(<LegalPageV2 type="privacy" />).container],
] as const
const DOCS = [
  ['v1', () => render(<DocsPage />).container],
  ['v2', () => render(<DocsTabV2 />).container],
] as const

describe.each(LEGAL)('Privacy Policy — %s', (_ui, mount) => {
  it('§3.2 says IPs are not stored and only hashed for rate limiting, and that wallet addresses are stored', () => {
    const collect = section(mount(), 'pp-collect')
    expect(collect).toContain('We do not collect or store your name, email address, home address, or date of birth.')
    expect(collect).toContain(PRIVACY_IP_STORAGE_NOTE)
    expect(collect).toContain(PRIVACY_WALLET_STORAGE_NOTE)
    expect(collect).not.toMatch(/email address, IP address, home address/) // the old absolute list
  })

  it('§5 opens with what is relayed, then names what is and is not', () => {
    const proxy = section(mount(), 'pp-proxy')
    expect(proxy.startsWith(PRIVACY_PROXY_CLAIM)).toBe(true)
    expect(proxy).toContain('What is relayed: Token balance checks, ERC-20 allowance reads, transaction receipt polling, Chainlink price feed queries, custom token imports, token logos, and all swap/quote requests to aggregator APIs')
    expect(proxy).toContain(`What is not relayed (by design): ${PRIVACY_DIRECT_NOTE} ${PRIVACY_WALLET_ADVICE}`)
    expect(proxy).toContain('MetaMask’s, if you pair the MetaMask mobile app from a browser without the extension')
    expect(proxy).toContain('Reown’s wallet directory, if you open WalletConnect’s own wallet list')
  })

  it('§5 no longer promises what the browser "never" does, or "maximum privacy"', () => {
    const proxy = section(mount(), 'pp-proxy')
    expect(proxy).not.toMatch(/shields your IP address|your browser never makes direct requests|What is (not )?protected|maximum privacy/i)
  })

  it('§8 names the analytics that does run, and stops claiming there is none', () => {
    const cookies = section(mount(), 'pp-cookies')
    expect(cookies).toContain('The Interface does not use cookies for tracking or advertising purposes, and it runs no advertising scripts.')
    expect(cookies).toContain('Page views are counted by Vercel Web Analytics, our hosting provider’s analytics, which is loaded from our own domain.')
    expect(cookies).toContain('It uses no cookies, and it reports page views in aggregate by country, device type, operating system, and browser. TeraSwap’s own code does not collect or store any of that.')
    expect(cookies).toContain('No third-party error-reporting or session-replay service runs in your browser.')
    expect(cookies).not.toMatch(/do not employ any third-party analytics/i)
  })
})

// [fix/user-ip-privacy A76 S-2] §3.3 said the local data "is never transmitted to our servers" — true of the browser's
// copy, false of the swaps and orders themselves (POSTed to /api/log-swap and /api/orders, read back by /api/history).
describe.each(LEGAL)('Privacy Policy §3.3 — %s', (_ui, mount) => {
  it("says the local copies stay local AND that every swap and order is stored server-side (the Auditor's wording)", () => {
    const collect = section(mount(), 'pp-collect')
    expect(collect).toContain(
      'These copies stay in your browser and are never uploaded as such. Separately, every swap and order you make is sent to our server and stored with your wallet address (see 3.2); that server record is what the History tab shows.',
    )
    expect(collect).not.toMatch(/never transmitted to our servers|remains exclusively on your device/i)
  })
})

describe('§3.3 is backed by the code: swaps and orders reach our server, and the History tab reads it back', () => {
  it('v1 and v2 History read /api/history; swaps are logged to /api/log-swap; orders are created at /api/orders', async () => {
    const { readFileSync } = await import('node:fs')
    const read = (f: string) => readFileSync(f, 'utf8')
    // Real calls, not comments: a `fetch(` of the route.
    expect(read('src/components/WalletHistory.tsx')).toMatch(/fetch\(\s*[`'"]\/api\/history/)
    expect(read('src/ui/v2/history/use-wallet-history.ts')).toMatch(/fetch\(\s*[`'"]\/api\/history/)
    expect(read('src/lib/analytics.ts')).toMatch(/fetch\(\s*'\/api\/log-swap'/)
    expect(read('src/lib/order-engine/supabase.ts')).toMatch(/fetch\(\s*'\/api\/orders'/)
  })
})

// [fix/user-ip-privacy A76 S-1] §6 said quotes go "via our server-side proxy" while the signed CoW order went from the
// browser to api.cow.fi. Both now go through our server; §6 says so for the signed order too.
describe.each(LEGAL)('Privacy Policy §6 — %s', (_ui, mount) => {
  it('names the signed CoW Protocol order among what our server relays', () => {
    const sharing = section(mount(), 'pp-sharing')
    expect(sharing).toContain(
      'When you request a swap quote, or submit a CoW Protocol order you have signed, the Interface sends your wallet address and transaction parameters (for a CoW Protocol order, the signed order itself) to the APIs of third-party aggregator and DEX protocols via our server-side proxy. Your IP address is not exposed to these services.',
    )
  })

  // [fix/privacy-no-usage-tracking, owner 2026-11-12] a reservation, not a practice; no analytics provider is named.
  it('reserves disclosure of the 3.2 records when a law or a valid legal order requires it, and names no analytics provider', () => {
    const sharing = section(mount(), 'pp-sharing')
    expect(sharing).toContain('We may disclose the records described in section 3.2 when a law or a valid legal order requires it.')
    expect(sharing).not.toMatch(/analytics provider|screen/i)
  })
})

// [fix/privacy-no-usage-tracking] The site stops recording how visitors use it; §3 says only what the code does.
describe.each(LEGAL)('Privacy Policy §3 and no usage tracking — %s', (_ui, mount) => {
  it('§3.1 says we read public on-chain data for the connected address, and no longer claims wallet screening', () => {
    const collect = section(mount(), 'pp-collect')
    expect(collect).toContain('we read publicly-available blockchain data for the connected address, such as balances, orders, and swap history, to show them to you.')
    expect(collect).not.toMatch(/screen wallet|blockchain analytics provider/i)
  })

  it('§3.2 says we do not collect device, OS, browser, clicks or usage patterns, sets no tracking cookies, and counts page views in aggregate', () => {
    const collect = section(mount(), 'pp-collect')
    expect(collect).toContain('Our own code does not collect your device type, operating system, browser, clicks, or usage patterns, and the Interface sets no tracking cookies.')
    expect(collect).toContain('Page views are counted by Vercel Web Analytics, which uses no cookies and reports them in aggregate by country, device type, operating system, and browser (see section 8).')
    expect(collect).toContain('We do not collect or store your name, email address, home address, or date of birth.')
    expect(collect).toContain(PRIVACY_IP_STORAGE_NOTE)
    expect(collect).toContain(PRIVACY_WALLET_STORAGE_NOTE)
    expect(PRIVACY_WALLET_STORAGE_NOTE).toMatch(/orders, swap history and quotes/)
    expect(collect).not.toMatch(/may automatically collect|general usage patterns\./i)
  })

  it('no other section promises screening, usage analysis or analytics-provider sharing', () => {
    const c = mount()
    const all = textOf(c)
    expect(all).not.toMatch(/Screen wallets|Analyze usage patterns|blockchain analytics providers|automatically collected technical data/i)
  })
})

// The owner's typography rule for Privacy, Terms and every privacy claim: no em dash, no spaced en dash.
const BAD_DASH = /\u2014|\s\u2013\s/
describe('Privacy, Terms and the privacy claims carry no em dash and no spaced en dash', () => {
  it.each([
    ['v1 privacy', () => render(<LegalPage type="privacy" />).container],
    ['v1 terms', () => render(<LegalPage type="terms" />).container],
    ['v2 privacy', () => render(<LegalPageV2 type="privacy" />).container],
    ['v2 terms', () => render(<LegalPageV2 type="terms" />).container],
  ] as const)('%s', (_name, mount) => {
    expect(textOf(mount())).not.toMatch(BAD_DASH)
  })

  it('every PRIVACY_* claim constant', async () => {
    const claims = (await import('@/config/product-claims')) as Record<string, unknown>
    const privacy = Object.entries(claims).filter(([k, v]) => k.startsWith('PRIVACY_') && typeof v === 'string')
    expect(privacy.length).toBeGreaterThanOrEqual(6)
    for (const [k, v] of privacy) expect(v as string, k).not.toMatch(BAD_DASH)
  })
})

describe('Privacy Policy — v1 and v2 carry the same sections, word for word', () => {
  // One UI mounted at a time: with both in the document the section ids exist twice, and jsdom's `#id` lookup inside
  // the second container then finds nothing.
  it.each(['pp-collect', 'pp-proxy', 'pp-sharing', 'pp-cookies'])('%s', (id) => {
    const v1 = section(render(<LegalPage type="privacy" />).container, id)
    cleanup()
    const v2 = section(render(<LegalPageV2 type="privacy" />).container, id)
    expect(v1.length).toBeGreaterThan(200)
    expect(v2).toBe(v1)
  })
})

describe.each(DOCS)('Docs "Privacy" — %s', (_ui, mount) => {
  const privacy = (c: HTMLElement) => textOf(c.querySelector('#privacy'))

  it('opens with what is relayed', () => {
    expect(privacy(mount())).toContain(PRIVACY_PROXY_CLAIM)
  })

  it('describes the proxy as it is: every chain, a read-only allow-list, no direct fallback, hashed rate-limit keys', () => {
    const p = privacy(mount())
    expect(p).toContain('There is no direct fallback: if the proxy is unreachable the read fails rather than going around it.')
    expect(p).toContain('Method Policy (Read-Only Allow-List)')
    expect(p).toContain('relays only a fixed list of read-only methods per chain')
    // [A76 S-3] eth_getLogs is off the allow-list: Docs 03 no longer lists logs among the relayed reads.
    expect(p).toContain('(balances, contract calls, receipts, blocks, fee data)')
    expect(p).toContain('Token logos are fetched by our server too and served from our own address.')
    // [A76 S-1] Docs 02: the signed CoW order and its tracking are relayed too.
    expect(p).toContain('and a CoW Protocol order you sign is submitted and tracked through /api/cow. Quote, swap and order requests do not go directly from your browser to these services.')
    expect(p).toContain(PRIVACY_IP_STORAGE_NOTE)
    expect(p).toContain('/api/token-logo')
  })

  it('says what cannot be relayed, and that wallet addresses are stored', () => {
    const p = privacy(mount())
    expect(p).toContain(`What We Cannot Relay${PRIVACY_DIRECT_NOTE} ${PRIVACY_WALLET_ADVICE}`)
    expect(p).toContain(`Note: ${PRIVACY_DIRECT_NOTE} ${PRIVACY_WALLET_ADVICE} ${PRIVACY_WALLET_STORAGE_NOTE}`)
  })

  it('no longer describes a blacklist, a direct-RPC fallback, or "maximum privacy"', () => {
    const p = privacy(mount())
    expect(p).not.toMatch(/Blacklist|whack-a-mole|Graceful Degradation|falls back to direct RPC|maximum privacy|privacy-preserving architecture that protects/i)
  })
})

describe('Docs "Privacy" — v1 and v2 carry the same text', () => {
  it('the whole section matches once the step numbering glue is normalised', () => {
    const norm = (c: HTMLElement) => textOf(c.querySelector('#privacy')).replace(/\s+/g, '')
    const v1 = norm(render(<DocsPage />).container)
    cleanup()
    const v2 = norm(render(<DocsTabV2 />).container)
    expect(v1.length).toBeGreaterThan(1_500)
    expect(v2).toBe(v1)
  })
})
