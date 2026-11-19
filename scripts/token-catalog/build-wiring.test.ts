/**
 * [fix/catalog-refresh-drops-untrusted] build.ts run() is the one place the rules meet the pipeline, and it is
 * only reachable with the network, so its wiring is pinned at text level (same approach as refresh-workflow.test.ts):
 * the growth breaker gets the owner's accepted sizes, the decision gets the held-back sources, the cap runs
 * with the chain's size bound BEFORE the catalog is written, and what is written is the capped catalog.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, 'build.ts'), 'utf8')

describe('build.ts wiring of rules A and B', () => {
  it('rule A: buildChainCatalog receives the owner-accepted sizes of this chain', () => {
    expect(src).toContain('acceptedSourceSizes: acceptedSourceSizesFor(chainId)')
  })
  it('rule A: decideRefresh receives the sources the breaker held back (PR body, issue and auto-merge read them)', () => {
    expect(src).toContain('heldBackSources: result.heldBackSources')
  })
  it('rule B: the cap runs with the chain\'s size bound and the 7-day volumes', () => {
    expect(src).toMatch(/decision = applyAdditionsCap\(decision, \{ \.\.\.capInput, volume7d: capVolumes, audit \}\)/)
    expect(src).toContain('sizeBound: CATALOG_SIZE_BOUND[chainId]')
  })
  it('the cap runs before the artifacts are written and before the catalog file is built from decision.catalog', () => {
    const cap = src.indexOf('decision = applyAdditionsCap(')
    expect(cap).toBeGreaterThan(-1)
    expect(cap).toBeLessThan(src.indexOf('writeDecisionArtifacts(chainId, decision, volume7d)'))
    expect(src.indexOf('writeDecisionArtifacts(chainId, decision, volume7d)')).toBeLessThan(src.indexOf('const finalTokens = decision.catalog'))
  })
  it('the cap is skipped for a blocked decision only', () => {
    expect(src).toMatch(/if \(!decision\.blocked\) \{\n\s+const capInput/)
  })
})
