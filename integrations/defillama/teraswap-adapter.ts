/**
 * TeraSwap — DefiLlama dimension-adapter (Aggregators). **In-repo mirror of the
 * MERGED upstream file**, kept here so this repo can review/diff/test what is
 * actually live on DefiLlama.
 *
 * Upstream path (merged 2026-07-09):
 *   DefiLlama/dimension-adapters → `aggregators/teraswap/index.ts`
 *
 * ── What this mirror CHANGES vs. what is live upstream ────────────────────
 * 0. Aggregates BOTH mainnet FeeCollector deployments. The frozen V1 contract
 *    (`docs/DEPLOYMENTS.md`, "FeeCollector V1 (frozen)" row,
 *    `0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD`) emitted the 5-argument
 *    `SwapWithFee(address,address,address,uint256,uint256)` — topic0
 *    `0xe41d09ea59537dbbeb0d52b509aff6db0348253cb4f871b7d2c163002576c042` —
 *    14 times between 2026-03-04 and 2026-04-24, before V2 took over. The live
 *    upstream adapter only reads V2's 7-arg event, so this entire pre-V2
 *    mainnet history (TeraSwap's first six weeks) reads as zero. This mirror
 *    issues a second `getLogs` on chain 1, against V1's own address and its
 *    own (5-arg) event shape, and sums it into the same `dailyVolume`/
 *    `dailyFees` as V2 — `tokenIn`/`totalAmount`/`feeAmount` sit in the same
 *    roles in both shapes (confirmed against
 *    `contracts/TeraSwapFeeCollectorV2_DEPRECATED_flat.sol`, which is V1's
 *    source despite the filename). V1's total: 14 logs. V2's total (7-arg,
 *    unchanged): 23 logs. Mainnet total: 37. Every chain's `start` is also
 *    derived from its contract's actual first log rather than an inherited,
 *    unverified date — mainnet's had read 2026-05-08, which was neither V1's
 *    real first log (2026-03-04, 65 days earlier) nor V2's (2026-05-26, 18
 *    days later) — it fell in the gap between the two and excluded both. Each
 *    `start` is then set to the day BEFORE that first log, because the
 *    runner's hourly run gate skips a chain for 23 of a day's 24 slots when
 *    `start` equals that day; the `chainConfig` comment below carries the
 *    mechanism and the measurement.
 * 1. Adds Arbitrum One (42161). The live adapter configures ONLY ethereum and
 *    base. `docs/DEPLOYMENTS.md` dates the Arbitrum prod flip 2026-07-20, but
 *    the chain's own logs put the FIRST `SwapWithFee` three days earlier, on
 *    2026-07-17 (block 484,739,263) — so the flip date is the wrong `start`,
 *    and the derived one is used instead. Either way it postdates the
 *    2026-07-09 upstream merge, which is why the chain was never configured.
 *
 *    Scale, stated honestly: chain 42161 has emitted **five** `SwapWithFee`
 *    events in total — 2026-07-17, two on 2026-07-20, two on 2026-08-03 — and
 *    none since (verified against head 2026-09-03T18:46Z). This corrects a
 *    configuration error that makes a live chain read as zero; it does not
 *    recover a meaningful amount of unreported volume.
 * 2. Rewrites `methodology.Volume`. The live text calls the FeeCollector "the
 *    single contract every TeraSwap swap routes fee-collection through". That
 *    is not true: the sources in `FEE_INCOMPATIBLE_SOURCES`
 *    (`src/lib/constants.ts`) take the identical 0.1% through their OWN
 *    partner-fee parameters and emit no `SwapWithFee`, so this adapter cannot
 *    and does not count them. Fees/Revenue/ProtocolRevenue wording is
 *    unchanged.
 *
 * ── Why this repo has no `dexs/teraswap/index.js` ─────────────────────────
 * `teraswap.js` in this directory is the pre-submission draft and still
 * describes the `dexs/` path and a `dexs/teraswap/index.js` target. It is
 * `@deprecated` and superseded by this file (`teraswap-adapter.ts` — the name
 * differs deliberately, so no extensionless import can resolve to the `.js`
 * draft instead); it is kept, not deleted
 * (CLAUDE.md rule #4). PR-NOTE.md documents the real upstream path and the
 * exact paste procedure.
 *
 * ── Event source ──────────────────────────────────────────────────────────
 * `TeraSwapFeeCollector.sol` emits, exactly once per fee-collected swap:
 *
 *   event SwapWithFee(
 *     address indexed user, address indexed router, address tokenIn,
 *     uint256 totalAmount, uint256 feeAmount, address tokenOut,
 *     uint256 outputAmount
 *   );
 *
 * `topic0` = keccak256 of the 7-arg signature =
 * 0x2a90a68b9cbf4190c9d99142f26df926cebcfd5d9d5c3594c691f188b0adf060 — the
 * same value `TOPICS.SwapWithFee` in `src/lib/on-chain-monitor.ts` already
 * keys off, and the topic0 observed on the Arbitrum fee tx recorded in
 * `docs/DEPLOYMENTS.md`
 * (`0xf14b181b91f1b3274fdaa19248d7619acadd21f0666cfbfbede40bdb660927b2`,
 * block 485,946,212, status 0x1).
 *
 * The frozen mainnet V1 contract (`TeraSwapFeeCollectorV2_DEPRECATED_flat.sol`
 * — V1's actual source, despite the filename) emits a narrower, 5-arg form of
 * the same event instead:
 *
 *   event SwapWithFee(
 *     address indexed user, address indexed router, address tokenIn,
 *     uint256 totalAmount, uint256 feeAmount
 *   );
 *
 * `tokenIn`, `totalAmount` and `feeAmount` sit in the same three positions as
 * the 7-arg event, so both shapes decode into the `SwapWithFeeLog` fields this
 * file actually reads. Its `topic0` —
 * 0xe41d09ea59537dbbeb0d52b509aff6db0348253cb4f871b7d2c163002576c042 — differs
 * from the 7-arg one in both hash and byte length, so no log can ever satisfy
 * both filters: the two event reads below can't double-count each other.
 */

/*
 * ── IN-REPO SHIM ──────────────────────────────────────────────────────────
 * Upstream, this file opens with exactly these three imports:
 *
 *   import { FetchOptions, SimpleAdapter } from "../../adapters/types";
 *   import { CHAIN } from "../../helpers/chains";
 *   import { METRIC } from "../../helpers/metrics";
 *
 * Those modules exist only inside dimension-adapters. To keep this mirror
 * type-checkable in THIS repo without adding a dependency, the four symbols
 * they provide are declared locally below, with the upstream literal values
 * (helpers/chains.ts, helpers/metrics.ts, read 2026-09-03). When pasting
 * upstream, delete this shim block and restore the three imports — nothing
 * below the shim changes.
 */
type SwapWithFeeLog = {
  tokenIn: string
  totalAmount: bigint
  feeAmount: bigint
}

type Balances = {
  add: (token: string, amount: bigint, metric?: string) => void
}

type FetchOptions = {
  chain: string
  getLogs: (args: { target: string; eventAbi: string }) => Promise<SwapWithFeeLog[]>
  createBalances: () => Balances
}

type SimpleAdapter = {
  version: number
  pullHourly: boolean
  fetch: (options: FetchOptions) => Promise<Record<string, Balances>>
  adapter: Record<string, { feeCollector: string; start: string; legacyFeeCollector?: string }>
  methodology: Record<string, string>
  breakdownMethodology: Record<string, Record<string, string>>
}

const CHAIN = {
  ETHEREUM: 'ethereum',
  BASE: 'base',
  ARBITRUM: 'arbitrum',
} as const

const METRIC = {
  SWAP_FEES: 'Token Swap Fees',
} as const
/* ── END IN-REPO SHIM ─────────────────────────────────────────────────── */

export const SWAP_WITH_FEE_EVENT =
  'event SwapWithFee(address indexed user, address indexed router, address tokenIn, uint256 totalAmount, uint256 feeAmount, address tokenOut, uint256 outputAmount)'

/**
 * The frozen mainnet V1 contract's own (5-arg) `SwapWithFee` shape. `tokenIn`
 * / `totalAmount` / `feeAmount` are in the same positions as
 * `SWAP_WITH_FEE_EVENT`, so `fetch` can decode both into the same
 * `SwapWithFeeLog` shape and sum them.
 */
export const SWAP_WITH_FEE_EVENT_V1 =
  'event SwapWithFee(address indexed user, address indexed router, address tokenIn, uint256 totalAmount, uint256 feeAmount)'

/**
 * Sources that collect the SAME 0.1% through their own partner-fee params
 * instead of the FeeCollector, so they emit no `SwapWithFee` and are invisible
 * to this adapter.
 *
 * This MUST stay equal to `FEE_INCOMPATIBLE_SOURCES` in `src/lib/constants.ts`
 * (it cannot import it — this file is pasted into a repo where `src/` does not
 * exist). `__tests__/defillama-teraswap-adapter.test.ts` asserts the equality
 * rather than trusting a reader to eyeball it.
 */
export const EXCLUDED_SOURCES = ['0x', 'cowswap', 'bebop'] as const

/** Display names for `EXCLUDED_SOURCES`, keyed by the same source ids. */
export const EXCLUDED_SOURCE_LABELS: Record<(typeof EXCLUDED_SOURCES)[number], string> = {
  '0x': '0x',
  cowswap: 'CoW Swap',
  bebop: 'Bebop',
}

// Rendered into the Volume methodology below, so the prose can never name a
// different set of sources than the list above.
const excludedLabels = EXCLUDED_SOURCES.map((s) => EXCLUDED_SOURCE_LABELS[s])
const excludedList =
  excludedLabels.length > 1
    ? `${excludedLabels.slice(0, -1).join(', ')} and ${excludedLabels[excludedLabels.length - 1]}`
    : excludedLabels.join('')

/**
 * FeeCollector per chain. Every address here was EXTRACTED from the table in
 * `docs/DEPLOYMENTS.md` (the repo's on-chain source of truth) qualified by
 * chain — never hand-typed — because the same address is a DIFFERENT contract
 * on different chains (that doc's "same address, different contract per chain"
 * gotcha). Each entry carries its source row, its 42-char length sentinel and
 * the `eth_getCode` size measured on ITS OWN chain on 2026-09-03.
 *
 * Every `start` is likewise DERIVED from that chain's first on-chain
 * `SwapWithFee` log — never inherited from a config or prod-flip date — and
 * is then set to the UTC day BEFORE that log. That last step is not slack:
 * `start` is a RUN GATE, not a provenance annotation. For a
 * `pullHourly: true` adapter the runner splits the day into 24 one-hour
 * slots and runs a chain in the slot ending at `endTimestamp` only when
 * `start <= endTimestamp - 86400` (`setChainValidStart` in
 * `adapters/utils/runAdapter.ts`; the slots are built by `runHourlyMultiSlot`
 * in `cli/testAdapter.ts`). A `start` equal to the day being measured passes
 * that test for the LAST slot only (23:00–00:00 UTC) and skips the chain for
 * the other 23 — so a chain started on its own first-log day reports ZERO
 * for that day unless the log happens to land in the final hour. Measured
 * against DefiLlama's own harness on 2026-09-04: Base with
 * `start: '2026-06-04'` reported 0.00 for 2026-06-04, where the same file
 * and day with an earlier `start` reports 2.71k.
 *
 * Starting a day early costs nothing — the extra day holds no logs and sums
 * to zero — and each first-log block, tx and timestamp is recorded verbatim
 * per chain below, so the derivation stays checkable either way.
 */
const chainConfig: Record<
  string,
  { feeCollector: string; start: string; legacyFeeCollector?: string }
> = {
  // docs/DEPLOYMENTS.md · row "**FeeCollector V2** (instant swaps)" · chain "Ethereum Mainnet (1)".
  // length sentinel 42 · eth_getCode on chain 1 (gateway.tenderly.co/public/mainnet) = 5,419 bytes.
  // start DERIVED: V2's first SwapWithFee is block 25,181,121, tx
  // 0xdeb17a805b0069c4641dd9e0e5e51bc88205f083bad288ad31dbb20ed296cdb6,
  // timestamp 1779818087 = 2026-05-26T17:54:47Z — NOT the mainnet start, since
  // `legacyFeeCollector` below has fills that predate it by 83 days. This
  // chain's `start` is derived from V1's first log instead (see the
  // legacyFeeCollector comment), replacing the previously configured
  // (unverified, and wrong either way) 2026-05-08.
  //
  // legacyFeeCollector: docs/DEPLOYMENTS.md · row "**FeeCollector V1** (frozen)"
  // · chain "Ethereum Mainnet (1)" · "deprecated, do not route here" for
  // ROUTING, but its 14 historical SwapWithFee logs are real settled volume
  // and belong in this adapter's count. length sentinel 42 · eth_getCode on
  // chain 1 = 5,826 bytes. start DERIVED: V1's first SwapWithFee is block
  // 24,585,100, tx 0xb42d6fda447057d1d84cdfbddd1ab8b3a22c83219a958e3414418d368a791973,
  // timestamp 1772639423 = 2026-03-04T15:50:23Z, the 2026-03-04 date in the
  // pre-V2 mainnet history this fixes — so `start` is 2026-03-03, the day
  // before, or the run gate above drops every hourly slot of 2026-03-04
  // except 23:00–00:00 and that opening day reads zero despite its two logs.
  // V1 emitted 14 SwapWithFee logs total (2026-03-04 through 2026-04-24, none
  // since; V2 has 23 to date, for 37 mainnet-wide) before V2 replaced it.
  [CHAIN.ETHEREUM]: {
    feeCollector: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459',
    legacyFeeCollector: '0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD',
    start: '2026-03-03',
  },
  // docs/DEPLOYMENTS.md · row "**FeeCollector** (instant swaps)" · chain "Base (8453)".
  // length sentinel 42 · eth_getCode on chain 8453 (mainnet.base.org) = 5,339 bytes.
  // start DERIVED: Base's first SwapWithFee is block 46,884,917, tx
  // 0x8c79514e0e793e7889ecebb986b1a969c93c84e3cce366e5931b7c5d74fedb00,
  // timestamp 1780559181 = 2026-06-04T07:46:21Z, five days after the
  // contract's own deploy (block 46,697,561, 2026-05-30T23:41:09Z) — so
  // `start` is 2026-06-03, the day before that first fill. Base is the chain
  // the run gate above was measured on: with `start: '2026-06-04'` its own
  // opening day reported 0.00, against 2.71k as configured here.
  [CHAIN.BASE]: {
    feeCollector: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    start: '2026-06-03',
  },
  // docs/DEPLOYMENTS.md · row "**FeeCollector** (instant swaps)" · chain "Arbitrum One (42161)".
  // Same 42-char string as the Base row — a deployer-nonce collision, a DIFFERENT
  // deployment; qualified by chain, verified on chain 42161 in its own right.
  // length sentinel 42 · eth_getCode on chain 42161 (arb1.arbitrum.io/rpc) = 5,339 bytes.
  // start DERIVED, not typed: the FIRST SwapWithFee log at this address on 42161 is
  // block 484,739,263 (tx 0xfa0dfc578960f7d720572de5d451ede06be38cc78ed2c39e00376b1cef4a658c),
  // timestamp 1784275673 = 2026-07-17T08:07:53Z — three days BEFORE the doc's
  // 2026-07-20 prod flip, so starting at the flip date would silently drop the
  // first of the chain's five SwapWithFee events (the other four are two on
  // 2026-07-20 and two on 2026-08-03; none since). `start` is 2026-07-16, the
  // day before that first log: at 08:07 UTC it is outside the only slot a
  // same-day `start` would have run, so 2026-07-17 would otherwise read zero.
  [CHAIN.ARBITRUM]: {
    feeCollector: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    start: '2026-07-16',
  },
}

const fetch = async (options: FetchOptions) => {
  const cfg = chainConfig[options.chain]

  const dailyVolume = options.createBalances()
  const dailyFees = options.createBalances()

  const accumulate = (log: SwapWithFeeLog) => {
    dailyVolume.add(log.tokenIn, log.totalAmount)
    dailyFees.add(log.tokenIn, log.feeAmount, METRIC.SWAP_FEES)
  }

  const logs = await options.getLogs({
    target: cfg.feeCollector,
    eventAbi: SWAP_WITH_FEE_EVENT,
  })
  for (const log of logs) accumulate(log)

  // Mainnet only: the frozen V1 contract's pre-V2 history, decoded from its
  // own (5-arg) event shape and summed into the same balances. Its address
  // and topic0 both differ from V2's, so this can never re-read a V2 log.
  if (cfg.legacyFeeCollector) {
    const legacyLogs = await options.getLogs({
      target: cfg.legacyFeeCollector,
      eventAbi: SWAP_WITH_FEE_EVENT_V1,
    })
    for (const log of legacyLogs) accumulate(log)
  }

  return {
    dailyVolume,
    dailyFees,
    dailyRevenue: dailyFees,
    dailyProtocolRevenue: dailyFees,
  }
}

const methodology = {
  Volume: `Sum of totalAmount (the pre-fee swap notional a user commits, in tokenIn) from every SwapWithFee event emitted by the TeraSwapFeeCollector proxy, the contract that collects the 0.1% on-chain before the trade is forwarded to the underlying DEX router. On Ethereum mainnet this aggregates both FeeCollector deployments — the frozen V1 contract and the live V2 contract that replaced it — so mainnet's reported history is continuous back to TeraSwap's first on-chain swap rather than starting at the V2 cutover. Not all TeraSwap volume reaches that contract: routes filled by ${excludedList} collect the identical 0.1% through those venues' own partner-fee parameters instead of the FeeCollector, emit no SwapWithFee event, and are therefore NOT counted here.`,
  Fees: 'A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap, read directly from the feeAmount field of each SwapWithFee event (no estimation — the exact on-chain value).',
  Revenue: "A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap, read directly from the feeAmount field of each SwapWithFee event (no estimation — the exact on-chain value).",
  ProtocolRevenue: "A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap, read directly from the feeAmount field of each SwapWithFee event (no estimation — the exact on-chain value).",
}

const breakdownMethodology = {
  Fees: {
    [METRIC.SWAP_FEES]: 'A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap.',
  },
  Revenue: {
    [METRIC.SWAP_FEES]: 'A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap.',
  },
  ProtocolRevenue: {
    [METRIC.SWAP_FEES]: 'A flat 0.1% (10 bps) fee taken by the FeeCollector on every swap.',
  },
}

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  adapter: chainConfig,
  methodology,
  breakdownMethodology,
}

export default adapter
