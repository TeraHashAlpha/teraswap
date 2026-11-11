/**
 * [SPRINT-9N] Regression guard for the Cross-Origin-Opener-Policy (COOP) header.
 *
 * COOP must be `same-origin-allow-popups` (NOT the stricter `same-origin`) so that
 * wallet popups the page itself opens — notably Coinbase Smart Wallet's
 * keys.coinbase.com/connect window — keep their `window.opener` and can return the
 * connection to the dApp. `same-origin` (originally set in SPRINT-6D) severed
 * window.opener and broke smart-wallet connect in production (SPRINT-9N).
 *
 * `same-origin-allow-popups` still isolates THIS document from cross-origin openers;
 * it only restores opener access for popups we open ourselves — the OWASP-recommended
 * value for wallet-popup dApps. CORP/CSP/HSTS are intentionally NOT relaxed.
 *
 * Both layers must carry the SAME value: the Next.js layer (`next.config.js` headers())
 * and the Vercel-edge layer (`vercel.json`). If they disagree the browser can receive
 * two conflicting COOP headers. This test pins both and asserts they agree, so any
 * future re-hardening that flips either back to `same-origin` fails loudly here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = join(__dirname, '../..')
const EXPECTED_COOP = 'same-origin-allow-popups'

/** COOP value declared in the Vercel-edge header config (vercel.json). */
function vercelCoop(): string | undefined {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8')) as {
    headers?: Array<{ headers?: Array<{ key: string; value: string }> }>
  }
  const all = (cfg.headers ?? []).flatMap((rule) => rule.headers ?? [])
  return all.find((h) => h.key === 'Cross-Origin-Opener-Policy')?.value
}

/** COOP value declared in the Next.js header config (next.config.js headers()). */
function nextConfigCoop(): string | undefined {
  const src = readFileSync(join(ROOT, 'next.config.js'), 'utf-8')
  // matches: key: 'Cross-Origin-Opener-Policy', \n value: '<captured>'
  return src.match(/'Cross-Origin-Opener-Policy',\s*value:\s*'([^']+)'/)?.[1]
}

// ── Content-Security-Policy ─────────────────────────────────────────────────────────────────────
// [fix/user-ip-privacy] The policy is data now (csp-policy.js): next.config.js builds the header from it
// and these tests read the same list, plus the header next.config.js actually returns.
const policy = require(join(ROOT, 'csp-policy.js')) as {
  WALLET_CONNECT_SOURCES: ReadonlyArray<{ source: string; wallet: string; reason: string }>
  CONNECT_SRC: readonly string[]
  IMG_SRC: readonly string[]
  buildContentSecurityPolicy: (o?: { isDev?: boolean }) => string
}

/** The CSP header next.config.js really serves (not a regex over its source). */
async function servedCsp(): Promise<string> {
  // next.config.js is CommonJS
  const nextConfig = require(join(ROOT, 'next.config.js')) as { headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>; images?: unknown }
  const rules = await nextConfig.headers()
  return rules.flatMap((r) => r.headers).find((h) => h.key === 'Content-Security-Policy')!.value
}
const directive = (csp: string, name: string): string[] =>
  csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? []

describe('[fix/user-ip-privacy] CSP — the browser may only reach our origin and the wallet hosts', () => {
  it('next.config.js serves exactly the policy built by csp-policy.js', async () => {
    expect(await servedCsp()).toBe(policy.buildContentSecurityPolicy({ isDev: false }))
  })

  it("connect-src is 'self' + the listed wallet hosts, and nothing else", async () => {
    const served = directive(await servedCsp(), 'connect-src')
    expect(served).toEqual(["'self'", ...policy.WALLET_CONNECT_SOURCES.map((s) => s.source)])
    expect(served).toEqual([
      "'self'",
      'wss://relay.walletconnect.org',
      'https://api.web3modal.org',
      'https://metamask-sdk.api.cx.metamask.io',
      'wss://metamask-sdk.api.cx.metamask.io',
    ])
  })

  it('every wallet host is an exact host (no wildcard, no path, no bare scheme) and says which wallet needs it and why', () => {
    expect(policy.WALLET_CONNECT_SOURCES.length).toBeGreaterThan(0)
    for (const { source, wallet, reason } of policy.WALLET_CONNECT_SOURCES) {
      expect(source).toMatch(/^(https|wss):\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      expect(source).not.toContain('*')
      expect(['WalletConnect', 'MetaMask']).toContain(wallet)
      expect(reason.length).toBeGreaterThan(60)
    }
    expect(new Set(policy.WALLET_CONNECT_SOURCES.map((s) => s.source)).size).toBe(policy.WALLET_CONNECT_SOURCES.length)
  })

  it.each([
    ['an RPC provider', /alchemy|infura|llamarpc|ankr|publicnode|merkle|base\.org|arbitrum\.io/],
    ['an aggregator or DEX API', /1inch|0x\.org|paraswap|kyberswap|cow\.fi|openocean|sushi|balancer/],
    ['Etherscan', /etherscan/],
    ['Supabase', /supabase/],
    ['Sentry', /sentry/],
    ['DefiLlama', /llama/],
    ['WalletConnect / Reown telemetry', /pulse\.walletconnect/],
    ["WalletConnect's own RPC, verify, echo or explorer API", /rpc\.walletconnect|verify\.walletconnect|echo\.walletconnect|explorer-api|web3modal\.com/],
    ['MetaMask SDK analytics', /mm-sdk-analytics/],
    ['a wildcard', /\*/],
    ['a bare scheme (https: / wss: / http:)', /^(https?|wss?):$/],
  ])('connect-src allows no %s', async (_what, pattern) => {
    expect(directive(await servedCsp(), 'connect-src').filter((s) => pattern.test(s))).toEqual([])
  })

  it("img-src is exactly 'self' data: blob: — no remote image host at all", async () => {
    expect(directive(await servedCsp(), 'img-src')).toEqual(["'self'", 'data:', 'blob:'])
    expect(policy.IMG_SRC).toEqual(["'self'", 'data:', 'blob:'])
  })

  it('next.config.js declares no image remotePatterns (the optimizer cannot be pointed at a third-party host)', () => {
    // next.config.js is CommonJS
    const nextConfig = require(join(ROOT, 'next.config.js')) as { images?: { remotePatterns?: unknown; domains?: unknown } }
    expect(nextConfig.images?.remotePatterns).toBeUndefined()
    expect(nextConfig.images?.domains).toBeUndefined()
    expect(readFileSync(join(ROOT, 'next.config.js'), 'utf-8')).not.toMatch(/^\s*remotePatterns\s*:/m)
  })

  it('no directive falls back to something wider than its own list', async () => {
    const csp = await servedCsp()
    expect(directive(csp, 'default-src')).toEqual(["'self'"])
    expect(directive(csp, 'frame-src')).toEqual(["'none'"])
    expect(directive(csp, 'object-src')).toEqual(["'none'"])
    expect(directive(csp, 'worker-src')).toEqual(["'self'"])
    expect(directive(csp, 'font-src')).toEqual(["'self'", 'data:'])
    expect(directive(csp, 'media-src')).toEqual(["'self'", 'blob:'])
    // script-src: no remote script host; 'unsafe-eval' only in development
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(directive(policy.buildContentSecurityPolicy({ isDev: true }), 'script-src')).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"])
  })
})

describe('[9N] Cross-Origin-Opener-Policy', () => {
  it('vercel.json sets COOP to same-origin-allow-popups (popups keep window.opener)', () => {
    expect(vercelCoop()).toBe(EXPECTED_COOP)
  })

  it('next.config.js sets COOP to same-origin-allow-popups', () => {
    expect(nextConfigCoop()).toBe(EXPECTED_COOP)
  })

  it('both layers agree, so the browser never sees conflicting COOP headers', () => {
    expect(nextConfigCoop()).toBe(vercelCoop())
  })
})
