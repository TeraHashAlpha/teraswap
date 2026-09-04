/**
 * Guards for the in-repo mirror of the MERGED DefiLlama adapter
 * (`integrations/defillama/teraswap-adapter.ts` ↔ upstream
 * `aggregators/teraswap/index.ts`).
 *
 * The two failures this file exists to prevent are the two the live upstream
 * adapter shipped with:
 *   1. a chain that has a production FeeCollector but no adapter entry, which
 *      reports as zero volume rather than as an error;
 *   2. a methodology paragraph that claims more coverage than the event source
 *      actually has.
 *
 * Every address is checked against `docs/DEPLOYMENTS.md` — the repo's on-chain
 * source of truth — by parsing the doc here, so a hand-typed or stale hex in
 * the adapter fails the suite instead of silently pointing at the wrong
 * contract. That matters more than usual for TeraSwap: the doc records TWO
 * address collisions where the same address is a different contract per chain,
 * so the check is always qualified by chain id.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { keccak256, toBytes, toEventSelector } from 'viem'
import { describe, expect, it } from 'vitest'

import { FEE_INCOMPATIBLE_SOURCES } from '@/lib/constants'

import adapter, {
  EXCLUDED_SOURCES,
  EXCLUDED_SOURCE_LABELS,
  SWAP_WITH_FEE_EVENT,
} from '../integrations/defillama/teraswap-adapter'

/** DefiLlama chain key → EVM chain id, for looking the row up in the doc. */
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
}

/**
 * FeeCollector addresses as recorded in `docs/DEPLOYMENTS.md`, keyed by chain
 * id. Parsed, never hand-copied. Excludes the frozen V1 row ("deprecated, do
 * not route here") and the Sepolia testnet row.
 */
function feeCollectorsFromDeploymentsDoc(): Record<number, string> {
  const doc = readFileSync(path.join(__dirname, '..', 'docs', 'DEPLOYMENTS.md'), 'utf8')
  const found: Record<number, string> = {}

  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 5) continue
    const [, role, chain, address] = cells
    if (!/FeeCollector/.test(role)) continue
    if (/V1/.test(role)) continue
    if (/testnet/i.test(role) || /Sepolia/i.test(chain)) continue

    const chainId = chain.match(/\((\d+)\)/)
    const hex = address.match(/^`(0x[0-9a-fA-F]{40})`$/)
    if (!chainId || !hex) continue
    found[Number(chainId[1])] = hex[1]
  }

  return found
}

describe('DefiLlama adapter — chain coverage', () => {
  it('configures exactly the three chains with a production FeeCollector', () => {
    expect(Object.keys(adapter.adapter).sort()).toEqual(['arbitrum', 'base', 'ethereum'])
  })

  it('was not shipped without Arbitrum One, which is what the live upstream adapter got wrong', () => {
    // Arbitrum's FeeCollector has been emitting SwapWithFee since 2026-07-17,
    // after the 2026-07-09 upstream merge; with no entry, a live chain reports
    // zero rather than erroring.
    expect(adapter.adapter.arbitrum).toBeDefined()
  })

  it('is a version 2 SimpleAdapter that pulls hourly, like the merged upstream file', () => {
    expect(adapter.version).toBe(2)
    expect(adapter.pullHourly).toBe(true)
  })

  it('gives every chain a start as a DATE STRING, not a unix timestamp', () => {
    for (const [chain, cfg] of Object.entries(adapter.adapter)) {
      expect(cfg.start, chain).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it("starts Arbitrum at the first SwapWithFee log's day, not the later prod-flip date", () => {
    // Derived on 42161: first SwapWithFee at this address is block 484,739,263,
    // timestamp 1784275673 = 2026-07-17T08:07:53Z. The doc's prod flip is
    // 2026-07-20 — starting there would drop the fills before it.
    expect(adapter.adapter.arbitrum.start).toBe('2026-07-17')
    expect(new Date(`${adapter.adapter.arbitrum.start}T00:00:00Z`).getTime() / 1000)
      .toBeLessThanOrEqual(1784275673)
  })
})

describe('DefiLlama adapter — addresses match docs/DEPLOYMENTS.md', () => {
  const fromDoc = feeCollectorsFromDeploymentsDoc()

  it('finds a FeeCollector row for each of the three chain ids in the doc', () => {
    expect(Object.keys(fromDoc).map(Number).sort((a, b) => a - b)).toEqual([1, 8453, 42161])
  })

  it.each(Object.keys(CHAIN_IDS))('%s: adapter address === the doc row for its chain', (chain) => {
    const configured = adapter.adapter[chain].feeCollector
    const documented = fromDoc[CHAIN_IDS[chain]]

    // Length sentinel: 0x + 40 hex chars.
    expect(configured.length).toBe(42)
    expect(documented.length).toBe(42)
    // Computed, case-insensitive equality — checksum casing must not decide this.
    expect(configured.toLowerCase()).toBe(documented.toLowerCase())
  })

  it('negative control: mainnet and Base are NOT the same FeeCollector', () => {
    expect(adapter.adapter.ethereum.feeCollector.toLowerCase())
      .not.toBe(adapter.adapter.base.feeCollector.toLowerCase())
  })

  it('collision control: Base and Arbitrum share an address, and that is deliberate', () => {
    // docs/DEPLOYMENTS.md: deployer-nonce alignment puts the same address on
    // both chains with DIFFERENT bytecode. The adapter is allowed to repeat it
    // only because each entry was verified on its own chain.
    expect(adapter.adapter.base.feeCollector.toLowerCase())
      .toBe(adapter.adapter.arbitrum.feeCollector.toLowerCase())
  })
})

describe('DefiLlama adapter — event signature', () => {
  const OBSERVED_TOPIC0 =
    // topic0 of the single FeeCollector log in Arbitrum tx
    // 0xf14b181b91f1b3274fdaa19248d7619acadd21f0666cfbfbede40bdb660927b2
    // (block 485,946,212, status 0x1), recorded in docs/DEPLOYMENTS.md.
    '0x2a90a68b9cbf4190c9d99142f26df926cebcfd5d9d5c3594c691f188b0adf060'

  it('the 7-arg event the adapter decodes hashes to the topic0 seen on-chain', () => {
    expect(toEventSelector(SWAP_WITH_FEE_EVENT)).toBe(OBSERVED_TOPIC0)
  })

  it('a 5-arg SwapWithFee does NOT hash to it (control against a truncated ABI)', () => {
    const fiveArg = keccak256(toBytes('SwapWithFee(address,address,address,uint256,uint256)'))
    expect(fiveArg).not.toBe(OBSERVED_TOPIC0)
  })
})

describe('DefiLlama adapter — methodology does not overclaim', () => {
  it('excludes exactly the sources in FEE_INCOMPATIBLE_SOURCES', () => {
    // Asserted, not eyeballed: if a source is added to or removed from the
    // canonical constant, this fails until the adapter's list follows.
    expect([...EXCLUDED_SOURCES]).toEqual([...FEE_INCOMPATIBLE_SOURCES])
  })

  it('has a display label for every excluded source and no extras', () => {
    expect(Object.keys(EXCLUDED_SOURCE_LABELS).sort()).toEqual([...EXCLUDED_SOURCES].sort())
  })

  it('drops the "every TeraSwap swap" claim the live upstream text makes', () => {
    expect(adapter.methodology.Volume).not.toContain('every TeraSwap swap')
    expect(adapter.methodology.Volume).not.toContain('the single contract')
  })

  it('names every excluded source and says why it is not counted', () => {
    for (const source of EXCLUDED_SOURCES) {
      expect(adapter.methodology.Volume).toContain(EXCLUDED_SOURCE_LABELS[source])
    }
    expect(adapter.methodology.Volume).toContain('partner-fee')
    expect(adapter.methodology.Volume).toContain('emit no SwapWithFee event')
    expect(adapter.methodology.Volume).toContain('NOT counted')
    // The excluded sources take the SAME fee — the adapter under-reports
    // volume, it does not describe a different fee model.
    expect(adapter.methodology.Volume).toContain('identical 0.1%')
  })

  it('leaves the Fees / Revenue / ProtocolRevenue wording untouched', () => {
    const feesText =
      'A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap, read directly from the feeAmount field of each SwapWithFee event (no estimation — the exact on-chain value).'
    expect(adapter.methodology.Fees).toBe(feesText)
    expect(adapter.methodology.Revenue).toBe(feesText)
    expect(adapter.methodology.ProtocolRevenue).toBe(feesText)
  })

  it('keeps the upstream breakdown metric key on every fee series', () => {
    for (const series of ['Fees', 'Revenue', 'ProtocolRevenue']) {
      expect(Object.keys(adapter.breakdownMethodology[series])).toEqual(['Token Swap Fees'])
    }
  })
})
