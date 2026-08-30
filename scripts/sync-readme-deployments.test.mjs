// Drives the shipped README address copier. Never hard-codes an expected hex.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
  parseDeploymentRows,
  findRow,
  extractReadmeTableAddresses,
} from './sync-readme-deployments.mjs'

const SCRIPT = fileURLToPath(new URL('./sync-readme-deployments.mjs', import.meta.url))
const ROOT = path.resolve(path.dirname(SCRIPT), '..')

describe('sync-readme-deployments', () => {
  const deployments = parseDeploymentRows(
    readFileSync(path.join(ROOT, 'docs/DEPLOYMENTS.md'), 'utf8'),
  )
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  const table = extractReadmeTableAddresses(readme)

  it('prints a 42-length sentinel for every copied address (table cells are 42 chars)', () => {
    for (const addr of table.addrs) {
      expect(addr.startsWith('0x')).toBe(true)
      expect(addr.length).toBe(42)
    }
  })

  it('does not alter the five addresses that were already in README on origin/main', () => {
    const origin = execFileSync('git', ['show', 'origin/main:README.md'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const originTable = extractReadmeTableAddresses(origin)
    expect(originTable.addrs).toHaveLength(5)
    for (const addr of originTable.addrs) {
      expect(table.addrs).toContain(addr)
    }
  })

  it('adds Base OrderExecutor v2 and Arbitrum V3 by copying DEPLOYMENTS.md', () => {
    const v2Base = findRow(
      deployments,
      /^OrderExecutor \(conditional/,
      /Base \(8453\)/,
      'v2 Base',
    )
    const v3Arb = findRow(
      deployments,
      /OrderExecutor V3/,
      /Arbitrum One/,
      'V3 Arbitrum',
    )
    expect(table.addrs).toContain(v2Base.address)
    expect(table.addrs).toContain(v3Arb.address)
    expect(readme).toMatch(/OrderExecutor v2 \(conditional orders\) \| Base/)
    expect(readme).toMatch(/OrderExecutor V3 \(conditional orders\) \| Arbitrum One/)
  })

  it('does not claim DCA live (the launch flag defaults off)', () => {
    expect(readme).not.toMatch(/DCA live/i)
    expect(readme).not.toMatch(/DCA orders are live/i)
    expect(readme).not.toMatch(/DCA is \*\*live/)
  })

  it('--check exits 0 against the current README table', () => {
    const stdout = execFileSync('node', [SCRIPT, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(stdout).toMatch(/matches docs\/DEPLOYMENTS\.md/)
  })
})
