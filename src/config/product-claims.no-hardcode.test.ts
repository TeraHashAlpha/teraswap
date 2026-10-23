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
  'src/components/LegalPage.tsx',
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
  { name: 'typed fee "0.1%"', re: /(?<![\d.])0\.1%/ },
  { name: 'absolute privacy claims', re: /never exposed|zero data leaks|hides your IP|IP hidden from all|IP[- ]protected|shields your IP from blockchain providers\./i },
  { name: 'absolute MEV/"zero" taglines', re: /zero predatory|zero compromises|MEV-free|never exposed to sandwich/i },
  { name: '"No bogus prices ever"', re: /no bogus prices/i },
  { name: 'gasless-approval claim (useApproval.ts:105-117 always uses exact on-chain approve)', re: /gasless approvals|gasless\s+token approvals|Permit2['"]? technology|Permit2 and EIP-2612 off-chain/i },
  { name: 'disabled source named as integrated in a source list', re: /Odos, KyberSwap|, OpenOcean,|and Balancer\b|Balancer\)/ },
  { name: 'typed rate limits', re: /300 requests|20 requests per minute/ },
  { name: 'unproven SL/TP "wider" slippage', re: /wider default slippage/ },
  { name: 'typed "10 bps" fee', re: /\b10 bps\b/ },
  { name: 'typed "0.01% – 1%" pool-fee range', re: /0\.01% – 1%/ },
  { name: 'typed ">8%" (DefiLlama block)', re: />8%/ },
  { name: 'typed ">5%" (cross-quote)', re: />5%/ },
  { name: 'typed "3×" (median outlier)', re: /\b3×/ },
  { name: 'typed "$10,000"', re: /\$10,000/ },
  { name: 'typed "10-second"', re: /10-second/ },
  { name: 'typed "48-hour" / "7-day"', re: /\b(48-hour|7-day)\b/ },
  { name: 'typed "[0.01%, 15%]" slippage clamp', re: /\[0\.01%, 15%\]/ },
  { name: 'typed fee-tier list', re: /0\.01%, 0\.05%/ },
  { name: 'unproven vendor counts (400+/100+/1000+/40+)', re: /\b(400|100|1000|40)\+/ },
  { name: 'unproven "30-day" window', re: /30-day/ },
  { name: 'unproven SL/TP slippage figures', re: /5% default slippage|standard 2% slippage|2% default slippage/ },
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
