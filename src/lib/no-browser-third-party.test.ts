/**
 * [fix/functional-chain-ui C8] Grep guard: browser code never names the two third-party hosts that
 * used to receive visitors' IPs directly — GitHub's raw CDN (Trust Wallet logos, TokenLogo) and
 * DefiLlama's price API (DCAPanel's fallback). Both now go through same-origin routes
 * (/api/proxy/logo, /api/price/defillama), and next.config.js no longer allows either host.
 *
 * "Client code" = everything under src/components and src/hooks, any module whose first statement
 * is 'use client', and the browser-side price helper. Outside it, a host may only appear in the
 * server-side modules allow-listed below, so a new occurrence anywhere has to be justified here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const HOSTS = ['raw.githubusercontent.com', 'coins.llama.fi']

const SERVER_ALLOWLIST = new Set([
  'src/app/api/proxy/logo/route.ts', // the Trust Wallet fetch itself
  'src/app/api/portfolio/prices/route.ts', // doc comment: why that route proxies DefiLlama
  'src/lib/defillama.ts', // server-side DefiLlama client (route handlers only)
  'src/lib/order-engine/dca-price-quorum.ts', // /api/dca-floor-cap price quorum
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const rel = (p: string) => relative(ROOT, p).split(sep).join('/')
const isTestOnly = (p: string) =>
  /\.test\.tsx?$/.test(p) || /\/(__tests__|__fixtures__|test-utils)\//.test(p)

const SOURCES = walk(join(ROOT, 'src'))
  .map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }))
  .filter((f) => /\.tsx?$/.test(f.path) && !isTestOnly(f.path))

const USE_CLIENT = /^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/

function isClient(f: { path: string; text: string }): boolean {
  return (
    f.path.startsWith('src/components/') ||
    f.path.startsWith('src/hooks/') ||
    f.path === 'src/lib/defillama-client.ts' ||
    USE_CLIENT.test(f.text)
  )
}

function hostHits(files: { path: string; text: string }[]): string[] {
  return files.flatMap((f) =>
    f.text.split('\n').flatMap((line, i) =>
      HOSTS.some((h) => line.includes(h)) ? [`${f.path}:${i + 1}: ${line.trim()}`] : [],
    ),
  )
}

describe('[C8] no browser-direct third-party hosts', () => {
  const client = SOURCES.filter(isClient)

  it('scans a real client surface (sanity)', () => {
    const paths = client.map((f) => f.path)
    expect(paths).toContain('src/components/TokenLogo.tsx')
    expect(paths).toContain('src/components/DCAPanel.tsx')
    expect(paths).toContain('src/lib/defillama-client.ts')
    expect(client.length).toBeGreaterThan(100)
  })

  it('client code names neither raw.githubusercontent.com nor coins.llama.fi — grep = 0', () => {
    expect(hostHits(client)).toEqual([])
  })

  it('client code takes no value import from the server-side DefiLlama module', () => {
    const VALUE_IMPORT = /import\s+(?!type\b)[^;]*?from\s+['"](?:@\/lib\/defillama|\.{1,2}\/(?:lib\/)?defillama)['"]/
    expect(client.filter((f) => VALUE_IMPORT.test(f.text)).map((f) => f.path)).toEqual([])
  })

  it('outside client code, only the allow-listed server modules name a host', () => {
    const files = new Set(hostHits(SOURCES).map((h) => h.split(':')[0]))
    expect([...files].filter((p) => !SERVER_ALLOWLIST.has(p))).toEqual([])
  })
})
