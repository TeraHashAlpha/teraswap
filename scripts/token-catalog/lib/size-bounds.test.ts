/**
 * [fix/catalog-refresh-drops-untrusted] The refresh clamps its additions to the room under each chain's size bound
 * (CATALOG_SIZE_BOUND, config.ts). The bounds themselves are the owner's gate and live as literals in
 * src/lib/chains/token-catalog.test.ts ("[9Y] search performance stays bounded"); this file fails when the two
 * tables disagree, in either direction, so the refresh can never clamp to a number the assertion does not use.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PIPELINE_CONFIG, CATALOG_SIZE_BOUND } from './config'

const testSrc = readFileSync(join(__dirname, '..', '..', '..', 'src', 'lib', 'chains', 'token-catalog.test.ts'), 'utf8')
const CHAIN_CONST: Record<number, string> = { 1: 'MAINNET', 8453: 'BASE', 42161: 'ARBITRUM' }

/** `expect(getFullCatalog(<CONST>).length).toBeLessThan(<N>)` literals in the assertion file. */
function assertedBounds(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of testSrc.matchAll(/expect\(getFullCatalog\((\w+)\)\.length\)\.toBeLessThan\((\d+)\)/g)) out[m[1]] = Number(m[2])
  return out
}

describe('CATALOG_SIZE_BOUND matches the size assertions in token-catalog.test.ts', () => {
  it('every pipeline chain has a bound in both places, with the same number', () => {
    const asserted = assertedBounds()
    for (const chainId of PIPELINE_CONFIG.chains) {
      const c = CHAIN_CONST[chainId]
      expect(c, `chain ${chainId} has no constant name in this test`).toBeDefined()
      expect(CATALOG_SIZE_BOUND[chainId], `chain ${chainId} has no CATALOG_SIZE_BOUND`).toBeGreaterThan(0)
      expect(asserted[c], `token-catalog.test.ts asserts no bound for chain ${chainId} (${c})`).toBe(CATALOG_SIZE_BOUND[chainId])
    }
  })
  it('the two original bounds are unchanged (mainnet < 1000, Base < 500) and Arbitrum is 389 + Base\'s 38 = 427', () => {
    expect(CATALOG_SIZE_BOUND).toEqual({ 1: 1000, 8453: 500, 42161: 427 })
  })
  it('no bound is asserted for a chain the pipeline does not run', () => {
    const known = new Set(PIPELINE_CONFIG.chains.map((c) => CHAIN_CONST[c]))
    for (const c of Object.keys(assertedBounds())) expect(known.has(c), `${c} is asserted but not a pipeline chain`).toBe(true)
  })
})
