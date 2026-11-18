// @vitest-environment node
/**
 * [fix/mainnet-rpc-out-of-client, SEC-5] No browser-reachable code reads a `NEXT_PUBLIC_*RPC*` env name.
 *
 * Next inlines a literal `process.env.NEXT_PUBLIC_*` read into every client chunk that can reach the module, even when
 * the read sits in a server-only branch. That is how the mainnet provider URL (key included) shipped to every visitor:
 * `primary: process.env.NEXT_PUBLIC_RPC_URL || …` in chains/registry.ts (Step 0 build of 4a4129ef, chunk
 * `1_7izng880dte.js`). The browser reads every chain through our own `/api/rpc` (rpc-proxy-url.ts); the server resolves
 * its upstream from server-only names (rpc-env.ts: `RPC_URL_<id>`).
 *
 * "Server-only" here (owner reading, docs/feedback/fix-mainnet-rpc-out-of-client.md): files under `src/app/api/`
 * (route handlers, never part of a client graph), and rpc-env.ts's `readServerOnly`, a COMPUTED, window-guarded read
 * that the bundler cannot inline, kept for the deprecated Base/Arbitrum server fallback (pinned by rpc-env.guard.test.ts).
 *
 *  1. No literal read of any NEXT_PUBLIC_*RPC* name (`process.env.X`, `process.env?.X`, `process.env['X']`,
 *     `{ X } = process.env`, or `.X` on any alias) in a non-test file under src/ outside src/app/api/. src/ui included.
 *  2. No NEXT_PUBLIC_*RPC* name as a bare string literal (the key a computed read is built from) outside src/app/api/
 *     and rpc-env.ts; in rpc-env.ts exactly the two deprecated L2 names.
 *  3. The three mainnet browser names appear in no non-test code under src/ in any form.
 *
 * Comments are stripped before scanning (a comment can name a variable; only code can read one).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(__dirname, '..')
const SERVER_ONLY_DIR = `app${sep}api${sep}`
const RPC_ENV = join('lib', 'rpc-env.ts')

const MAINNET_NAMES = ['NEXT_PUBLIC_RPC_URL', 'NEXT_PUBLIC_FALLBACK_RPC_1', 'NEXT_PUBLIC_FALLBACK_RPC_2'] as const
const DEPRECATED_L2_NAMES = ['NEXT_PUBLIC_ARBITRUM_RPC_URL', 'NEXT_PUBLIC_BASE_RPC_URL']

const NAME = String.raw`NEXT_PUBLIC_[A-Z0-9_]*RPC[A-Z0-9_]*`
/** Rule 1: any literal read. Member access on process.env or an alias, bracket literal, destructuring. */
const LITERAL_READS = [
  new RegExp(String.raw`(?:\?\.|\.)\s*${NAME}\b`),
  new RegExp(String.raw`process\.env\s*(?:\?\.\s*)?\[\s*['"\`]${NAME}['"\`]\s*\]`),
  new RegExp(String.raw`\{[^{}]*\b${NAME}\b[^{}]*\}\s*=\s*process\.env\b`),
]
/** Rule 2: the name as a whole string literal. */
const NAME_LITERAL = new RegExp(String.raw`(['"\`])(${NAME})\1`, 'g')

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sources(p)
    return /\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ? [p] : []
  })
}

const files = sources(SRC).map((p) => ({ rel: relative(SRC, p), code: stripComments(readFileSync(p, 'utf8')) }))
const clientReachable = files.filter((f) => !f.rel.startsWith(SERVER_ONLY_DIR))

describe('[SEC-5] the scanner is not vacuous', () => {
  it('scans every source file under src/, src/ui included', () => {
    expect(files.length).toBeGreaterThan(300)
    expect(files.some((f) => f.rel.startsWith(`ui${sep}`))).toBe(true)
    expect(files.some((f) => f.rel === RPC_ENV)).toBe(true)
  })

  it('rule 1 catches every literal read form, and not a computed read or a server-only name', () => {
    const hit = (s: string) => LITERAL_READS.some((re) => re.test(s))
    for (const read of [
      'process.env.NEXT_PUBLIC_RPC_URL',
      'process.env . NEXT_PUBLIC_FALLBACK_RPC_1',
      'process.env?.NEXT_PUBLIC_BASE_RPC_URL',
      "process.env['NEXT_PUBLIC_ARBITRUM_RPC_URL']",
      'process.env?.["NEXT_PUBLIC_FALLBACK_RPC_2"]',
      'const { NEXT_PUBLIC_RPC_URL } = process.env',
      'const { a, NEXT_PUBLIC_RPC_URL: url } = process.env',
      'env.NEXT_PUBLIC_RPC_URL',
    ]) expect([read, hit(read)]).toEqual([read, true])
    for (const notRead of ['process.env[name]', 'process.env.RPC_URL_1', 'process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'NEXT_PUBLIC_BASE_RPC_URL: boolean']) {
      expect([notRead, hit(notRead)]).toEqual([notRead, false])
    }
  })

  it('rule 2 sees the string-literal names rpc-env.ts holds (positive control)', () => {
    const rpcEnv = files.find((f) => f.rel === RPC_ENV)!
    expect([...rpcEnv.code.matchAll(NAME_LITERAL)].length).toBeGreaterThan(0)
  })
})

describe('[SEC-5] no client-reachable NEXT_PUBLIC_*RPC* read', () => {
  it('rule 1: no literal read outside src/app/api/', () => {
    const offenders = clientReachable
      .filter((f) => LITERAL_READS.some((re) => re.test(f.code)))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it('rule 2: no name-as-string-literal outside src/app/api/ and rpc-env.ts; rpc-env.ts holds only the two deprecated L2 names', () => {
    const offenders = clientReachable
      .filter((f) => f.rel !== RPC_ENV)
      .flatMap((f) => [...f.code.matchAll(NAME_LITERAL)].map((m) => `${f.rel}: ${m[2]}`))
    expect(offenders).toEqual([])
    const rpcEnv = files.find((f) => f.rel === RPC_ENV)!
    const names = [...new Set([...rpcEnv.code.matchAll(NAME_LITERAL)].map((m) => m[2]))].sort()
    expect(names).toEqual(DEPRECATED_L2_NAMES)
  })

  it.each(MAINNET_NAMES)('rule 3: %s appears in no source code under src/ (any form)', (name) => {
    const re = new RegExp(String.raw`\b${name}\b`)
    expect(files.filter((f) => re.test(f.code)).map((f) => f.rel)).toEqual([])
  })
})
