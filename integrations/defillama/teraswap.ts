/**
 * TeraSwap — DefiLlama dimension-adapter (Aggregators). **In-repo mirror of the
 * MERGED upstream file**, kept here so this repo can review/diff/test what is
 * actually live on DefiLlama.
 *
 * Upstream path (merged 2026-07-09):
 *   DefiLlama/dimension-adapters → `aggregators/teraswap/index.ts`
 *
 * ── What this mirror CHANGES vs. what is live upstream ────────────────────
 * 1. Adds Arbitrum One (42161). The live adapter configures ONLY ethereum and
 *    base; Arbitrum's FeeCollector reached production 2026-07-20, eleven days
 *    AFTER the upstream merge, so every Arbitrum swap since has reported as
 *    zero volume and zero fees.
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
 * `@deprecated` and superseded by this file; it is kept, not deleted
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
  adapter: Record<string, { feeCollector: string; start: string }>
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
 */
const chainConfig: Record<string, { feeCollector: string; start: string }> = {
  // docs/DEPLOYMENTS.md · row "**FeeCollector V2** (instant swaps)" · chain "Ethereum Mainnet (1)".
  // length sentinel 42 · eth_getCode on chain 1 (ethereum-rpc.publicnode.com) = 5,419 bytes.
  [CHAIN.ETHEREUM]: {
    feeCollector: '0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459',
    start: '2026-05-08',
  },
  // docs/DEPLOYMENTS.md · row "**FeeCollector** (instant swaps)" · chain "Base (8453)".
  // length sentinel 42 · eth_getCode on chain 8453 (mainnet.base.org) = 5,339 bytes.
  [CHAIN.BASE]: {
    feeCollector: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    start: '2026-05-30',
  },
  // docs/DEPLOYMENTS.md · row "**FeeCollector** (instant swaps)" · chain "Arbitrum One (42161)".
  // Same 42-char string as the Base row — a deployer-nonce collision, a DIFFERENT
  // deployment; qualified by chain, verified on chain 42161 in its own right.
  // length sentinel 42 · eth_getCode on chain 42161 (arb1.arbitrum.io/rpc) = 5,339 bytes.
  // start DERIVED, not typed: the FIRST SwapWithFee log at this address on 42161 is
  // block 484,739,263 (tx 0xfa0dfc578960f7d720572de5d451ede06be38cc78ed2c39e00376b1cef4a658c),
  // timestamp 1784275673 = 2026-07-17T08:07:53Z — three days BEFORE the doc's
  // 2026-07-20 prod flip, so starting at the flip date would drop real fills.
  [CHAIN.ARBITRUM]: {
    feeCollector: '0xeFC31ADb5d10c51Ac4383bB770E2fdC65780f130',
    start: '2026-07-17',
  },
}

const fetch = async (options: FetchOptions) => {
  const target = chainConfig[options.chain].feeCollector

  const logs = await options.getLogs({
    target,
    eventAbi: SWAP_WITH_FEE_EVENT,
  })

  const dailyVolume = options.createBalances()
  const dailyFees = options.createBalances()

  for (const log of logs) {
    dailyVolume.add(log.tokenIn, log.totalAmount)
    dailyFees.add(log.tokenIn, log.feeAmount, METRIC.SWAP_FEES)
  }

  return {
    dailyVolume,
    dailyFees,
    dailyRevenue: dailyFees,
    dailyProtocolRevenue: dailyFees,
  }
}

const methodology = {
  Volume: `Sum of totalAmount (the pre-fee swap notional a user commits, in tokenIn) from every SwapWithFee event emitted by the TeraSwapFeeCollector proxy, the contract that collects the 0.1% on-chain before the trade is forwarded to the underlying DEX router. Not all TeraSwap volume reaches that contract: routes filled by ${excludedList} collect the identical 0.1% through those venues' own partner-fee parameters instead of the FeeCollector, emit no SwapWithFee event, and are therefore NOT counted here.`,
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
