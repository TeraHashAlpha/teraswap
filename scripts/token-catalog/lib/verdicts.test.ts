/**
 * [fix/token-sync-cron-landing] writeTrustFixture — per-chain MERGE, not whole-file overwrite.
 *
 * The token-sync cron now runs one chain per matrix job (build.ts's TOKENS_SYNC_CHAINS
 * scope). Before this fix, writeTrustFixture always replaced the ENTIRE catalog-guard.trust.json
 * with whatever verdicts the current run collected — a single-chain run would silently wipe
 * every OTHER chain's cached verdicts, failing their `verdict-cache` guard check for a reason
 * unrelated to that chain. These tests prove a scoped run touches only its own chain's rows.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Verdict } from '@/lib/chains/catalog-guard'
import { writeTrustFixture } from './verdicts'

function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const tmpFiles: string[] = []
function tmpFixture(): string {
  const f = path.join(os.tmpdir(), `catalog-guard.trust.${process.pid}.${Math.random().toString(36).slice(2)}.json`)
  tmpFiles.push(f)
  return f
}

afterEach(() => {
  while (tmpFiles.length) {
    const f = tmpFiles.pop()!
    fs.rmSync(f, { force: true })
  }
})

const arbRow: Verdict = {
  chainId: 42161,
  address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  symbol: 'WETH',
  inTrustedList: true,
  hasBytecode: true,
  transferable: true,
  onchainSymbol: 'WETH',
  decimals: 18,
}

const mainnetRowOld: Verdict = {
  chainId: 1,
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  inTrustedList: true,
  hasBytecode: true,
  transferable: true,
  onchainSymbol: 'WETH',
  decimals: 18,
}

const baseRowNew: Verdict = {
  chainId: 8453,
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  inTrustedList: true,
  hasBytecode: true,
  transferable: true,
  onchainSymbol: 'USDC',
  decimals: 6,
}

describe('writeTrustFixture — per-chain merge', () => {
  it('a run for chain 8453 leaves a fixture containing 42161 rows byte-identical', () => {
    const file = tmpFixture()
    // seed the fixture as if a prior full run had written both chains
    writeTrustFixture([arbRow, mainnetRowOld], [42161, 1], file)
    const before = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: Verdict[] }
    const arbRowsBefore = before.tokens.filter((t) => t.chainId === 42161)
    expect(arbRowsBefore).toHaveLength(1)
    const hashBefore = hash(arbRowsBefore)

    // a chain-8453-scoped run must not touch the 42161 rows
    writeTrustFixture([baseRowNew], [8453], file)
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: Verdict[] }
    const arbRowsAfter = after.tokens.filter((t) => t.chainId === 42161)
    expect(hash(arbRowsAfter)).toBe(hashBefore)

    // the file bytes for the untouched row are identical too, not just deep-equal (the row
    // is nested 2 levels into the payload — tokens[] then the object — so +2 spaces/line).
    const rawAfter = fs.readFileSync(file, 'utf8')
    expect(rawAfter).toContain(JSON.stringify(arbRow, null, 1).split('\n').join('\n  '))
  })

  it('the scoped chain (8453) rows ARE replaced by the new run', () => {
    const file = tmpFixture()
    const staleBase: Verdict = { ...baseRowNew, inTrustedList: false } // pretend a stale prior verdict
    writeTrustFixture([arbRow, staleBase], [42161, 8453], file)

    writeTrustFixture([baseRowNew], [8453], file)
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: Verdict[] }
    const baseRows = after.tokens.filter((t) => t.chainId === 8453)
    expect(baseRows).toEqual([baseRowNew])
  })

  it('a chain missing from this run keeps zero rows if it had none, and gains none', () => {
    const file = tmpFixture()
    writeTrustFixture([mainnetRowOld], [1], file)
    writeTrustFixture([baseRowNew], [8453], file)
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: Verdict[] }
    expect(after.tokens.filter((t) => t.chainId === 1)).toEqual([mainnetRowOld])
    expect(after.tokens.filter((t) => t.chainId === 8453)).toEqual([baseRowNew])
    expect(after.tokens).toHaveLength(2)
  })

  it('generatedFromChains reflects every chain represented in the merged fixture', () => {
    const file = tmpFixture()
    writeTrustFixture([mainnetRowOld], [1], file)
    writeTrustFixture([baseRowNew], [8453], file)
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { generatedFromChains: number[] }
    expect(after.generatedFromChains).toEqual([1, 8453])
  })

  it('a first-ever run (no existing fixture) still writes cleanly', () => {
    const file = tmpFixture() // never written to
    const { count } = writeTrustFixture([arbRow], [42161], file)
    expect(count).toBe(1)
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: Verdict[] }
    expect(after.tokens).toEqual([arbRow])
  })
})
