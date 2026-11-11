// @vitest-environment node
/**
 * [fix/user-ip-privacy] Sentry is NOT initialised — in the browser or on the server — and the privacy
 * copy says so. This pins the three facts that make it true (docs/security/SENTRY-STATUS.md):
 *
 *  1. there is no `instrumentation-client.ts` (the only client init hook Turbopack honours) and no
 *     `instrumentation.ts` (the only server/edge init hook) — at the repo root or under src/;
 *  2. nothing under src/ imports a `sentry.*.config` file;
 *  3. next.config.js sets no Sentry `tunnelRoute`.
 *
 * If Sentry is ever wanted, this test must change together with the Privacy Policy and the CSP.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [p] : []
  })
}

describe('Sentry is not initialised', () => {
  it.each(['instrumentation', 'instrumentation-client'])('no %s.{ts,js,mjs,tsx} at the repo root or in src/', (base) => {
    for (const dir of [ROOT, SRC]) {
      for (const ext of ['ts', 'tsx', 'js', 'mjs']) {
        expect([relative(ROOT, join(dir, `${base}.${ext}`)), existsSync(join(dir, `${base}.${ext}`))]).toEqual([relative(ROOT, join(dir, `${base}.${ext}`)), false])
      }
    }
  })

  it('the three sentry.*.config.ts files still exist (unused) — this test is about them, not a stale leftover', () => {
    for (const f of ['sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts']) {
      expect([f, existsSync(join(ROOT, f))]).toEqual([f, true])
    }
  })

  it('nothing under src/ imports a sentry.*.config file or calls Sentry.init', () => {
    const files = walk(SRC).filter((p) => !/\.(test|spec)\.[tj]sx?$/.test(p))
    expect(files.length).toBeGreaterThan(300)
    const offenders = files.filter((p) => {
      const text = readFileSync(p, 'utf8')
      return /sentry\.(client|server|edge)\.config/.test(text) || /Sentry\s*\.\s*init\s*\(/.test(text)
    })
    expect(offenders.map((p) => relative(ROOT, p))).toEqual([])
  })

  it('next.config.js configures no Sentry tunnel route', () => {
    const src = readFileSync(join(ROOT, 'next.config.js'), 'utf8')
    expect(src).not.toMatch(/tunnelRoute/)
  })

  it('the status is written down where the next person will look', () => {
    const doc = readFileSync(join(ROOT, 'docs/security/SENTRY-STATUS.md'), 'utf8')
    expect(doc).toMatch(/Sentry sends nothing from production today/)
  })
})
