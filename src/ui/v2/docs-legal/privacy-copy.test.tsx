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
    expect(cookies).toContain('No third-party error-reporting or session-replay service runs in your browser.')
    expect(cookies).not.toMatch(/do not employ any third-party analytics/i)
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
