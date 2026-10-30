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
