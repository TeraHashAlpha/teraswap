/**
 * [L-8, A75] The mobile Playwright config's webServer spawns `npx next start` with no explicit `cwd` — Playwright
 * defaults that to the directory the CONFIG FILE lives in (src/ui/v2/__tests__/mobile/), which has no
 * package.json/.next build output, so the documented command (`npx playwright test --config
 * src/ui/v2/__tests__/mobile/playwright.config.ts`) fails outside a shell already cd'd to the repo root. The
 * webServer must run from the repo root regardless of the caller's own cwd.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

async function loadConfig() {
  const mod = await import('./playwright.config')
  return mod.default
}

describe('mobile playwright.config.ts: webServer.cwd', () => {
  afterEach(() => {
    delete process.env.V2_BASE_URL
  })

  it('resolves to the repo root, not the config file\'s own directory', async () => {
    delete process.env.V2_BASE_URL
    const config = await loadConfig()
    const cwd = config.webServer && 'cwd' in config.webServer ? (config.webServer as { cwd?: string }).cwd : undefined
    expect(cwd).toBeTruthy()
    expect(existsSync(join(cwd!, 'package.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(cwd!, 'package.json'), 'utf8')).name).toBe('teraswap')
  })
})
