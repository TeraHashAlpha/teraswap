/**
 * @vitest-environment node
 *
 * [ADR-025] v1 must never import the v2 tree: a client module reachable from a v1 page's server graph is
 * bundled into that page's chunks (measured), shipping v2 to v1 visitors. Only the switch (proxy.ts), the
 * admin route and the v2 routes may reference src/ui/v2.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', '..')
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const ALLOWED = [
  'ui/v2/', // the tree itself
  'app/v2/', // v2 routes
  'proxy.ts',
  'proxy.test.ts',
  'app/api/admin/ui-version/',
  // [B7, owner-approved 2026-10-31] The APPROX_PRICES guard lists `ui/v2/dca/positions-model.ts` as a display-only importer: a path
  // string in a test's allow-list (data, never an import), and a test file is never bundled into a page.
  'lib/order-engine/usd-scope-guard.test.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (SOURCE.test(name)) out.push(p)
  }
  return out
}

describe('v1 never imports src/ui/v2', () => {
  it('no source outside the switch, admin route and v2 routes references ui/v2', () => {
    const offenders = walk(SRC)
      .map((f) => relative(SRC, f))
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) => /ui\/v2/.test(readFileSync(join(SRC, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('app/page.tsx (the v1 landing) is untouched by v2: no v2 import, still a client page', () => {
    const page = readFileSync(join(SRC, 'app', 'page.tsx'), 'utf8')
    expect(page).not.toMatch(/ui\/v2|next\/dynamic.*HomeV2/)
    expect(page.startsWith("'use client'")).toBe(true)
  })
})
