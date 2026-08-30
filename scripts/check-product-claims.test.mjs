// Drives the shipped checker. Does not re-implement the claim regex.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterEach } from 'vitest'
import {
  findViolations,
  checkContent,
  checkFiles,
  runCheck,
  USER_FACING_FILES,
  ROOT,
} from './check-product-claims.mjs'

const SCRIPT = fileURLToPath(new URL('./check-product-claims.mjs', import.meta.url))

const sandboxes = []
function sandboxDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'product-claims-'))
  sandboxes.push(dir)
  return dir
}

function spawnChecker(args, cwd = ROOT) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }
  }
}

afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop(), { recursive: true, force: true })
})

describe('check-product-claims — fixture control', () => {
  it('fails a fixture that hard-codes "11 sources"', () => {
    const violations = findViolations('TeraSwap meta-aggregates 11 sources for every swap.')
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0].match).toMatch(/11 sources/)

    const dir = sandboxDir()
    const rel = 'src/components/SwapBox.tsx'
    mkdirSync(path.join(dir, 'src/components'), { recursive: true })
    writeFileSync(path.join(dir, rel), 'TeraSwap meta-aggregates 11 sources for every swap.\n')
    const report = runCheck(dir, [rel])
    expect(report.ok).toBe(false)
    expect(report.code).toBe(1)
    expect(report.stderr).toContain('11 sources')
  })

  it('fails spelled-out counts and live-status chain names', () => {
    expect(findViolations('scans eleven liquidity sources across Ethereum').length).toBeGreaterThan(0)
    expect(findViolations('queries 10 liquidity sources to find').length).toBeGreaterThan(0)
    expect(findViolations('Live on Ethereum Mainnet').length).toBeGreaterThan(0)
    expect(findViolations('OrderExecutor V3 (conditional orders, DCA live)').length).toBeGreaterThan(0)
  })

  it('does not flag a user-order toast ("Your DCA is live")', () => {
    expect(findViolations("Your DCA is live — it will execute automatically on schedule.")).toEqual([])
  })

  it('does not flag a derived interpolation or a 10-second timeout', () => {
    const derived = `
      import { INTEGRATED_DEX_SOURCE_COUNT } from '@/config/product-claims'
      const x = \`\${INTEGRATED_DEX_SOURCE_COUNT} DEX sources\`
      const t = 'independent 10-second timeout. No source blocks another'
    `
    expect(findViolations(derived)).toEqual([])
    expect(checkContent(derived, 'src/components/SwapBox.tsx').imported).toBe(true)
  })
})

describe('check-product-claims — live tree (post commit 2)', () => {
  it('passes the current user-facing files', () => {
    const result = runCheck()
    expect(result.ok).toBe(true)
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/0 hard-coded/)
  })

  it('CLI exit 0 on the repo; each listed file exists', () => {
    const spawned = spawnChecker([])
    expect(spawned.code).toBe(0)
    const results = checkFiles()
    expect(results.map((r) => r.filename)).toEqual([...USER_FACING_FILES])
    for (const r of results) {
      expect(r.violations).toEqual([])
    }
  })
})
