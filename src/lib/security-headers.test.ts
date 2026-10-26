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

/** connect-src sources declared in next.config.js (the only CSP layer: vercel.json mirrors all but CSP). */
function nextConfigConnectSrc(): string[] {
  const src = readFileSync(join(ROOT, 'next.config.js'), 'utf-8')
  return src.match(/"connect-src ([^"]+)"/)?.[1].split(/\s+/) ?? []
}

/** img-src sources declared in next.config.js. */
function nextConfigImgSrc(): string[] {
  const src = readFileSync(join(ROOT, 'next.config.js'), 'utf-8')
  return src.match(/"img-src ([^"]+)"/)?.[1].split(/\s+/) ?? []
}

// [fix/functional-chain-ui C8] Supersedes the [fix/dca-consent-copy-and-tier-check] allowance: the
// floor classifier moved server-side (/api/dca-floor-cap) and DCAPanel's own price fallback now goes
// through /api/price/defillama, so no browser code may reach DefiLlama — or GitHub's raw host for
// Trust Wallet logos (/api/proxy/logo) — directly.
describe('[fix/functional-chain-ui C8] CSP — third parties stay behind /api', () => {
  it('connect-src allows no DefiLlama origin', () => {
    expect(nextConfigConnectSrc()).toEqual(expect.arrayContaining(["'self'"]))
    expect(nextConfigConnectSrc().filter(s => s.includes('llama.fi'))).toEqual([])
  })

  it('img-src allows no raw.githubusercontent.com', () => {
    expect(nextConfigImgSrc()).toEqual(expect.arrayContaining(["'self'"]))
    expect(nextConfigImgSrc().filter(s => s.includes('githubusercontent'))).toEqual([])
  })

  // [chore/copy-leftovers] /api/token-logo streams CoinGecko bytes server-side (#591), so no browser <img>
  // loads assets.coingecko.com any more. tokens.1inch.io stays: usePortfolio + importedTokenLogo still load it.
  it('img-src allows no CoinGecko origin, but keeps tokens.1inch.io', () => {
    expect(nextConfigImgSrc().filter(s => s.includes('coingecko'))).toEqual([])
    expect(nextConfigImgSrc()).toContain('https://tokens.1inch.io')
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
