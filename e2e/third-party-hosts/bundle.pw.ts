/**
 * [fix/user-ip-privacy] Values that must never be shipped to a visitor are not in the built client chunks.
 *
 * `CAPTURE_BUNDLE_MARKERS` is a comma-separated list of strings the BUILD was given as env values — the deprecated L2
 * provider URLs, the public Supabase URL / anon key, a Sentry DSN (see .github/workflows/e2e.yml). The test searches
 * every file under `.next/static` for them. A hit means a browser-bundled module reads that env again with a literal
 * `process.env.NEXT_PUBLIC_*`, which Next inlines into the client. Skipped when the variable is not set.
 */
import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const APP_DIR = process.env.CAPTURE_APP_DIR ? resolve(process.env.CAPTURE_APP_DIR) : resolve(__dirname, '../..')
const MARKERS = (process.env.CAPTURE_BUNDLE_MARKERS ?? '').split(',').map((m) => m.trim()).filter(Boolean)

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

test('the client bundle carries none of the build-time secrets / deprecated provider URLs', () => {
  test.skip(MARKERS.length === 0, 'CAPTURE_BUNDLE_MARKERS not set')
  const files = walk(join(APP_DIR, '.next', 'static')).filter((p) => /\.(js|css|json|html|txt)$/.test(p))
  expect(files.length, 'a built client exists').toBeGreaterThan(20)
  const hits: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const marker of MARKERS) if (text.includes(marker)) hits.push(`${marker} in ${file.slice(APP_DIR.length + 1)}`)
  }
  expect(hits).toEqual([])
})
