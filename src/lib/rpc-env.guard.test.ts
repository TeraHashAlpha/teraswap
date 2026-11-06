// @vitest-environment node
/**
 * [FEAT-SERVER-RPC-ENV-SPLIT] Guard: a server file must not read a browser RPC env directly.
 * Server RPC URLs come from `serverRpcUrl` / `serverRpcEnvUrl` (src/lib/rpc-env.ts); a new
 * `process.env.NEXT_PUBLIC_*RPC*` read in server code silently re-couples it to the browser key
 * (and to its domain allowlist). Comments are stripped before scanning.
 *
 * ALLOWLIST = modules that ARE the browser/shared config. Adding to it needs a reason:
 *  - rpc-env.ts          the resolver itself (the only place that names them for the server)
 *  - chains/registry.ts  shared registry; its `rpc.primary` is the browser value, the server
 *                        overrides it through rpc-env (clients.ts / adapters/shared.ts / api.ts)
 *  - wagmiConfig.ts      browser wagmi transports (polling budgets, #622)
 *
 * [fix/user-ip-privacy] Second guard, stricter and with NO allowlist: nothing under src/ may read
 * NEXT_PUBLIC_BASE_RPC_URL or NEXT_PUBLIC_ARBITRUM_RPC_URL with a literal member access. Next inlines
 * a literal `process.env.NEXT_PUBLIC_*` into every client chunk that can reach the module, which is
 * how the L2 provider URL (key included) reached every visitor. The two names survive only as a
 * server-side fallback, read through a computed lookup in rpc-env.ts (`readServerOnly`).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')
const ALLOW = new Set(['lib/rpc-env.ts', 'lib/chains/registry.ts', 'lib/wagmiConfig.ts'])
const SKIP_DIRS = new Set(['ui', 'node_modules', '__tests__', 'test-utils'])
const READ = /process\.env\s*(?:\.\s*|\[\s*['"`])NEXT_PUBLIC_[A-Z0-9_]*RPC/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(p)
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [p] : []
  })
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('no direct NEXT_PUBLIC_*RPC* env reads outside the allowlist', () => {
  it('scans real files (non-vacuous)', () => {
    expect(walk(SRC).length).toBeGreaterThan(100)
    expect(readFileSync(join(SRC, 'lib/rpc-env.ts'), 'utf8')).toMatch(READ)
  })

  it('the scan pattern catches dot and bracket reads', () => {
    expect(READ.test('process.env.NEXT_PUBLIC_RPC_URL')).toBe(true)
    expect(READ.test("process.env['NEXT_PUBLIC_BASE_RPC_URL']")).toBe(true)
    expect(READ.test('process.env.RPC_URL_1')).toBe(false)
  })

  it('no offender', () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => !ALLOW.has(rel))
      .filter((rel) => READ.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))))
    expect(offenders).toEqual([])
  })
})

describe('[fix/user-ip-privacy] the deprecated L2 browser env names are never inlined', () => {
  const L2_LITERAL = /process\.env\s*(?:\.\s*|\[\s*['"`])NEXT_PUBLIC_(?:BASE|ARBITRUM)_RPC_URL/
  /** Every non-test source file under src/, including src/ui (which the guard above skips). */
  const allSources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : allSources(p)
      return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) ? [p] : []
    })

  it('the pattern catches dot and literal-bracket reads, and not the computed server-only read', () => {
    expect(L2_LITERAL.test('process.env.NEXT_PUBLIC_BASE_RPC_URL')).toBe(true)
    expect(L2_LITERAL.test("process.env['NEXT_PUBLIC_ARBITRUM_RPC_URL']")).toBe(true)
    expect(L2_LITERAL.test('process.env . NEXT_PUBLIC_BASE_RPC_URL')).toBe(true)
    expect(L2_LITERAL.test('process.env[name]')).toBe(false)
    expect(L2_LITERAL.test('process.env.NEXT_PUBLIC_RPC_URL')).toBe(false)
  })

  it('no source file under src/ reads either name literally', () => {
    const files = allSources(SRC)
    expect(files.length).toBeGreaterThan(300)
    const offenders = files
      .map((p) => relative(SRC, p))
      .filter((rel) => L2_LITERAL.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))))
    expect(offenders).toEqual([])
  })

  it('rpc-env.ts still knows both names, as a server-only computed read', () => {
    const src = stripComments(readFileSync(join(SRC, 'lib/rpc-env.ts'), 'utf8'))
    expect(src).toContain("'NEXT_PUBLIC_BASE_RPC_URL'")
    expect(src).toContain("'NEXT_PUBLIC_ARBITRUM_RPC_URL'")
    expect(src).toMatch(/typeof window !== 'undefined'\) return undefined\s+return DEPRECATED_L2_PUBLIC_NAMES\.includes\(name\) \? process\.env\[name\]/)
  })

  it('wagmiConfig.ts and chains/registry.ts no longer mention either name in code', () => {
    for (const rel of ['lib/wagmiConfig.ts', 'lib/chains/registry.ts', 'lib/chains/clients.ts', 'lib/adapters/shared.ts']) {
      const src = stripComments(readFileSync(join(SRC, rel), 'utf8'))
      expect([rel, /NEXT_PUBLIC_(?:BASE|ARBITRUM)_RPC_URL/.test(src)]).toEqual([rel, false])
    }
  })
})
