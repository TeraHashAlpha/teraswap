/**
 * Owner rule: every number on a product surface is a slot of product-claims.ts, never typed in a
 * component. This fails the build if one of the retired literals is typed back into a surface.
 * Comments are stripped first (they may legitimately name the old value).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SURFACES = [
  'src/components/LandingPage.tsx',
  'src/components/LandingBelowFold.tsx',
  'src/components/DocsPage.tsx',
  'src/components/SourceToggle.tsx',
]

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'literal 29 (Chainlink feeds)', re: /(?<![\w.#$/-])29(?![\w.%/-])/ },
  { name: 'literal "8/8" (sources)', re: /\b8\/8\b/ },
  { name: 'literal "100% gasless"', re: /100%[\s\S]{0,80}?gasless/i },
  { name: 'literal "Zero front-running"', re: /zero front-running/i },
  { name: '"No approval gas fees, ever"', re: /no approval gas fees, ever/i },
  { name: '"eliminate front-running"', re: /eliminate front-running/i },
  { name: 'CoW-solver fill claim on Limit/SL-TP', re: /CoW Protocol solvers compete to fill/i },
  { name: 'stale tagline', re: /Ethereum Elite/i },
  { name: 'literal "roughly 30" (feeds)', re: /roughly 30\b/i },
  { name: 'staleness "every hour"', re: /staleness check every hour/i },
]

describe('product surfaces carry no hard-coded claim literals', () => {
  for (const file of SURFACES) {
    const src = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
    for (const { name, re } of FORBIDDEN) {
      it(`${file}: no ${name}`, () => {
        expect(src).not.toMatch(re)
      })
    }
  }

  it('the claim-bearing surfaces import from product-claims', () => {
    for (const file of SURFACES) {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).toContain("'@/config/product-claims'")
    }
  })
})
