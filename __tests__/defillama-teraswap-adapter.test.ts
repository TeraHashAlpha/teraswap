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
  SWAP_WITH_FEE_EVENT_V1,
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

/**
 * The frozen mainnet V1 row, parsed separately: `feeCollectorsFromDeploymentsDoc`
 * deliberately excludes it (it is not a chain the live adapter routes to), but
 * mainnet's `legacyFeeCollector` must still trace back to that exact row.
 */
function legacyFeeCollectorFromDeploymentsDoc(): string | undefined {
  const doc = readFileSync(path.join(__dirname, '..', 'docs', 'DEPLOYMENTS.md'), 'utf8')

  for (const line of doc.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 5) continue
    const [, role, chain, address] = cells
    if (!/FeeCollector V1/.test(role)) continue
    if (!/Ethereum Mainnet/.test(chain)) continue

    const hex = address.match(/^`(0x[0-9a-fA-F]{40})`$/)
    if (hex) return hex[1]
  }

  return undefined
}

const DAY = 86400

/**
 * The first on-chain `SwapWithFee` log per chain, as a unix timestamp. These
 * are the same values recorded block-by-block in the adapter's per-chain
 * comments; restating them here means the `start` rules below are asserted
 * against on-chain evidence rather than against another copy of `start`.
 */
const FIRST_LOG_TIMESTAMP: Record<string, number> = {
  // V1, block 24,585,100 — 2026-03-04T15:50:23Z (V2's own first log is
  // 1779818087 = 2026-05-26T17:54:47Z, 83 days later).
  ethereum: 1772639423,
  // block 46,884,917 — 2026-06-04T07:46:21Z
  base: 1780559181,
  // block 484,739,263 — 2026-07-17T08:07:53Z
  arbitrum: 1784275673,
}

const startOfUtcDay = (timestamp: number) => Math.floor(timestamp / DAY) * DAY

const startTimestampOf = (chain: string) =>
  new Date(`${adapter.adapter[chain].start}T00:00:00Z`).getTime() / 1000

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

  it("starts mainnet from V1's first SwapWithFee log, since V1 predates V2", () => {
    // Derived on chain 1: V1's first SwapWithFee is block 24,585,100, timestamp
    // 1772639423 = 2026-03-04T15:50:23Z, 83 days before V2's own first log
    // (block 25,181,121, 2026-05-26T17:54:47Z). Mainnet's start must be V1's,
    // or the pre-V2 history this adapter now counts would be excluded by its
    // own `start`.
    expect(startTimestampOf('ethereum')).toBeLessThanOrEqual(FIRST_LOG_TIMESTAMP.ethereum)
    expect(startTimestampOf('ethereum')).toBeLessThan(1779818087)
  })

  it("starts Arbitrum from the first SwapWithFee log, not the later prod-flip date", () => {
    // Derived on 42161: first SwapWithFee at this address is block 484,739,263,
    // timestamp 1784275673 = 2026-07-17T08:07:53Z. The doc's prod flip is
    // 2026-07-20 — starting there would drop the fills before it.
    const prodFlip = new Date('2026-07-20T00:00:00Z').getTime() / 1000
    expect(startTimestampOf('arbitrum')).toBeLessThanOrEqual(FIRST_LOG_TIMESTAMP.arbitrum)
    expect(startTimestampOf('arbitrum')).toBeLessThan(prodFlip)
  })

  it("starts Base from the first SwapWithFee log, not from nothing at all", () => {
    // Deploy block 46,697,561 (2026-05-30T23:41:09Z) predates the first fill —
    // block 46,884,917, 2026-06-04T07:46:21Z (timestamp 1780559181) — by five days.
    expect(startTimestampOf('base')).toBeLessThanOrEqual(FIRST_LOG_TIMESTAMP.base)
  })

  it.each(Object.keys(FIRST_LOG_TIMESTAMP))(
    '%s: start is the UTC day immediately before that chain\'s first log',
    (chain) => {
      // Derived, not chosen: exactly one day before the first log's UTC day.
      // Earlier would be harmless but unmoored from the evidence; later loses
      // the opening day outright (the run-gate test below).
      expect(startTimestampOf(chain)).toBe(startOfUtcDay(FIRST_LOG_TIMESTAMP[chain]) - DAY)
    },
  )

  it.each(Object.keys(FIRST_LOG_TIMESTAMP))(
    "%s: start clears the runner's hourly run gate for the whole first-log day",
    (chain) => {
      // THE REGRESSION GUARD. `start` is a RUN GATE, not a provenance note.
      // DefiLlama's runner (`setChainValidStart`, adapters/utils/runAdapter.ts)
      // runs a chain in the hourly slot ending at `endTimestamp` only when
      // `start <= endTimestamp - 86400`, and `pullHourly: true` splits each day
      // into 24 such slots (`runHourlyMultiSlot`, cli/testAdapter.ts). The
      // earliest slot of the first-log day ends at 01:00 UTC, so the entire day
      // runs only when `start <= firstLogDay + 3600 - 86400`. Fail this and the
      // chain silently reports 0.00 for its own opening day.
      const earliestSlotEnd = startOfUtcDay(FIRST_LOG_TIMESTAMP[chain]) + 3600
      expect(startTimestampOf(chain)).toBeLessThanOrEqual(earliestSlotEnd - DAY)
    },
  )

  it('negative control: the starts shipped in #476 fail that run gate', () => {
    // Measured against DefiLlama's own harness on 2026-09-04, these three
    // same-day starts produced ethereum 0.00 on 2026-03-04, base 0.00 on
    // 2026-06-04 (against a baseline 2.71k) and arbitrum 0.00 on 2026-07-17.
    // If this control ever passes, the gate arithmetic above has drifted and
    // the guard has stopped guarding.
    const shipped: Record<string, string> = {
      ethereum: '2026-03-04',
      base: '2026-06-04',
      arbitrum: '2026-07-17',
    }
    for (const [chain, start] of Object.entries(shipped)) {
      const startTs = new Date(`${start}T00:00:00Z`).getTime() / 1000
      const earliestSlotEnd = startOfUtcDay(FIRST_LOG_TIMESTAMP[chain]) + 3600
      expect(startTs, chain).toBeGreaterThan(earliestSlotEnd - DAY)
    }
  })
})

describe('DefiLlama adapter — mainnet aggregates both FeeCollector deployments', () => {
  const legacyFromDoc = legacyFeeCollectorFromDeploymentsDoc()

  it("mainnet's legacyFeeCollector matches the frozen V1 row in docs/DEPLOYMENTS.md", () => {
    expect(legacyFromDoc).toBeDefined()
    const configured = adapter.adapter.ethereum.legacyFeeCollector
    expect(configured).toBeDefined()
    expect(configured!.length).toBe(42)
    expect(configured!.toLowerCase()).toBe(legacyFromDoc!.toLowerCase())
  })

  it('double-counting is structurally impossible: V1 and V2 are different addresses', () => {
    // The real risk of aggregating two sources into one chain: a mutation
    // that points legacyFeeCollector at the same address as feeCollector
    // would double-count every V2 log. This fails the moment that happens.
    expect(adapter.adapter.ethereum.legacyFeeCollector!.toLowerCase())
      .not.toBe(adapter.adapter.ethereum.feeCollector.toLowerCase())
  })

  it('double-counting is structurally impossible: V1 and V2 events hash to different topic0s', () => {
    expect(toEventSelector(SWAP_WITH_FEE_EVENT_V1)).not.toBe(toEventSelector(SWAP_WITH_FEE_EVENT))
  })

  it("V1's 5-arg event hashes to the topic0 observed on its own historical logs", () => {
    // topic0 of V1's SwapWithFee, read off its own bytecode (contracts/
    // TeraSwapFeeCollectorV2_DEPRECATED_flat.sol) and confirmed against its
    // 14 on-chain logs (2026-03-04 – 2026-04-24).
    expect(toEventSelector(SWAP_WITH_FEE_EVENT_V1)).toBe(
      '0xe41d09ea59537dbbeb0d52b509aff6db0348253cb4f871b7d2c163002576c042',
    )
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

/**
 * What `fetch` does with the logs it is handed, against a stub `getLogs`.
 *
 * Scope, stated honestly: this CANNOT catch the #476 regression. That failure
 * happened in DefiLlama's runner *before* `fetch` was ever called, so a test
 * that calls `fetch` directly sees nothing wrong. The run-gate test in the
 * chain-coverage block above is the guard for that. What this block catches is
 * the adjacent failure — a `fetch` that stops issuing `getLogs` on some chain,
 * or reads a log without summing it — which no other test here would notice.
 */
describe('DefiLlama adapter — fetch sums logs on every configured chain', () => {
  type RecordedAdd = { token: string; amount: bigint; metric?: string }

  /** One log per `getLogs` call, with a recorder for every balance mutation. */
  function stubOptions(chain: string) {
    const getLogsCalls: { target: string; eventAbi: string }[] = []
    const balances: RecordedAdd[][] = []

    const options = {
      chain,
      getLogs: async (args: { target: string; eventAbi: string }) => {
        getLogsCalls.push(args)
        return [{ tokenIn: `${chain}-token`, totalAmount: 1_000n, feeAmount: 1n }]
      },
      createBalances: () => {
        const sink: RecordedAdd[] = []
        balances.push(sink)
        return {
          add: (token: string, amount: bigint, metric?: string) =>
            sink.push({ token, amount, metric }),
        }
      },
    }

    return { options, getLogsCalls, balances }
  }

  const chains = Object.keys(FIRST_LOG_TIMESTAMP)

  it.each(chains)('%s: a log from getLogs reaches dailyVolume AND dailyFees', async (chain) => {
    const { options, getLogsCalls, balances } = stubOptions(chain)

    const result = await adapter.fetch(options)

    // The chain queried at least one contract...
    expect(getLogsCalls.length).toBeGreaterThan(0)
    // ...and every log it got back landed in both balances, none dropped.
    const [dailyVolume, dailyFees] = balances
    expect(dailyVolume.length).toBe(getLogsCalls.length)
    expect(dailyFees.length).toBe(getLogsCalls.length)
    expect(dailyVolume.every((add) => add.amount === 1_000n)).toBe(true)
    expect(dailyFees.every((add) => add.amount === 1n)).toBe(true)
    expect(dailyFees.every((add) => add.metric === 'Token Swap Fees')).toBe(true)
    // Revenue and protocol revenue are the same balances object as fees.
    expect(result.dailyRevenue).toBe(result.dailyFees)
    expect(result.dailyProtocolRevenue).toBe(result.dailyFees)
  })

  it('queries two contracts on mainnet and exactly one on every other chain', async () => {
    for (const chain of chains) {
      const { options, getLogsCalls } = stubOptions(chain)
      await adapter.fetch(options)

      expect(getLogsCalls.length, chain).toBe(chain === 'ethereum' ? 2 : 1)
      // Distinct targets AND distinct event shapes — the double-count control
      // from the V1 work, asserted on the calls actually issued.
      expect(new Set(getLogsCalls.map((c) => c.target)).size, chain).toBe(getLogsCalls.length)
      expect(new Set(getLogsCalls.map((c) => c.eventAbi)).size, chain).toBe(getLogsCalls.length)
    }
  })
})
