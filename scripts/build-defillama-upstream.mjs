#!/usr/bin/env node
/**
 * Generates `integrations/defillama/upstream/index.ts` from
 * `integrations/defillama/teraswap-adapter.ts` — the file that pastes
 * directly into DefiLlama/dimension-adapters' `aggregators/teraswap/index.ts`
 * with no hand edits.
 *
 * See `integrations/defillama/PR-NOTE.md` § "Pasting it upstream" for the
 * three edits this automates: delete the in-repo shim and restore the three
 * upstream imports, drop `export` from the four test-only symbols, and
 * rewrite repo-internal provenance comments into evidence an outside
 * reviewer can check without this repo (chain id, eth_getCode byte count,
 * first-log block and tx hash — never a path like `docs/DEPLOYMENTS.md` or
 * `src/lib/...` that only exists here).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')

const SOURCE_PATH = path.join(REPO_ROOT, 'integrations/defillama/teraswap-adapter.ts')
const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, 'integrations/defillama/upstream/index.ts')

const SHIM_START_MARKER = '/*\n * ── IN-REPO SHIM'
const BODY_START_MARKER = 'export const SWAP_WITH_FEE_EVENT ='

const UPSTREAM_HEADER = `// TeraSwap — DefiLlama dimension-adapter (Aggregators).
//
// Sums SwapWithFee events from TeraSwap's FeeCollector contracts across
// Ethereum mainnet (both the frozen V1 and live V2 deployments), Base, and
// Arbitrum One. Every per-chain comment below carries evidence an outside
// reviewer can check independently: chain id, the eth_getCode byte length
// measured on that chain, and the first SwapWithFee log's block and tx hash.
//
// Source: https://github.com/TeraHashAlpha/teraswap/blob/main/integrations/defillama/teraswap-adapter.ts

import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { METRIC } from "../../helpers/metrics";

/**
 * Local decoded-log shape for \`SwapWithFee\`. DefiLlama's own
 * \`FetchOptions.getLogs\` returns \`Promise<any[]>\` — the SDK exports no type
 * for the fields an \`eventAbi\` decodes into, so this is declared locally
 * rather than imported; \`any[]\` is freely assignable to it.
 */
type SwapWithFeeLog = {
  tokenIn: string
  totalAmount: bigint
  feeAmount: bigint
}

`

/**
 * Body-level provenance rewrites: exact substring → replacement. Each `from`
 * must be found in the source exactly once, or the build fails loudly — this
 * is what makes drift in the mirror impossible to paper over silently.
 */
const BODY_REWRITES = [
  [
    ` * This MUST stay equal to \`FEE_INCOMPATIBLE_SOURCES\` in \`src/lib/constants.ts\`
 * (it cannot import it — this file is pasted into a repo where \`src/\` does not
 * exist). \`__tests__/defillama-teraswap-adapter.test.ts\` asserts the equality
 * rather than trusting a reader to eyeball it.`,
    ` * This MUST stay equal to the protocol's own list of fee-incompatible
 * sources — those that collect the identical fee through their own
 * partner-fee parameters instead of this contract, so they emit no
 * \`SwapWithFee\` and cannot be counted here.`,
  ],
  [
    ` * FeeCollector per chain. Every address here was EXTRACTED from the table in
 * \`docs/DEPLOYMENTS.md\` (the repo's on-chain source of truth) qualified by
 * chain — never hand-typed — because the same address is a DIFFERENT contract
 * on different chains (that doc's "same address, different contract per chain"
 * gotcha). Each entry carries its source row, its 42-char length sentinel and
 * the \`eth_getCode\` size measured on ITS OWN chain on 2026-09-03. Every
 * \`start\` is likewise DERIVED from that chain's first on-chain \`SwapWithFee\`
 * log, never inherited from a config or prod-flip date.`,
    ` * FeeCollector per chain. Every address here was verified on its own chain
 * — never hand-typed — because the same address is, in one case below, a
 * DIFFERENT contract on a different chain (a deployer-nonce collision, not
 * the same deployment). Each entry carries its 42-char length sentinel and
 * the \`eth_getCode\` size measured on ITS OWN chain. Every \`start\` is
 * DERIVED from that chain's first on-chain \`SwapWithFee\` log, never a
 * config or prod-flip date.`,
  ],
  [
    '  // docs/DEPLOYMENTS.md · row "**FeeCollector V2** (instant swaps)" · chain "Ethereum Mainnet (1)".',
    '  // FeeCollector V2 (instant swaps), Ethereum Mainnet (chain id 1).',
  ],
  [
    '  // legacyFeeCollector: docs/DEPLOYMENTS.md · row "**FeeCollector V1** (frozen)"\n  // · chain "Ethereum Mainnet (1)" · "deprecated, do not route here" for',
    '  // legacyFeeCollector: FeeCollector V1 (frozen), Ethereum Mainnet (chain id 1).\n  // "deprecated, do not route here" for',
  ],
  [
    '  // docs/DEPLOYMENTS.md · row "**FeeCollector** (instant swaps)" · chain "Base (8453)".',
    '  // FeeCollector (instant swaps), Base (chain id 8453).',
  ],
  [
    '  // docs/DEPLOYMENTS.md · row "**FeeCollector** (instant swaps)" · chain "Arbitrum One (42161)".',
    '  // FeeCollector (instant swaps), Arbitrum One (chain id 42161).',
  ],
]

const EXPORTED_SYMBOLS = [
  'SWAP_WITH_FEE_EVENT_V1',
  'SWAP_WITH_FEE_EVENT',
  'EXCLUDED_SOURCES',
  'EXCLUDED_SOURCE_LABELS',
]

const REPO_INTERNAL_PATH_NEEDLES = [
  'docs/DEPLOYMENTS.md',
  'src/lib/',
  'contracts/',
  '__tests__/',
  'CLAUDE.md',
]

export function buildUpstreamSource(sourceText) {
  const shimStart = sourceText.indexOf(SHIM_START_MARKER)
  if (shimStart === -1) {
    throw new Error(`could not find shim start marker ${JSON.stringify(SHIM_START_MARKER)} in source`)
  }
  const bodyStart = sourceText.indexOf(BODY_START_MARKER, shimStart)
  if (bodyStart === -1) {
    throw new Error(`could not find body start marker ${JSON.stringify(BODY_START_MARKER)} after shim`)
  }

  let body = sourceText.slice(bodyStart)

  for (const [from, to] of BODY_REWRITES) {
    const count = body.split(from).length - 1
    if (count !== 1) {
      throw new Error(
        `expected exactly one occurrence of a body rewrite target, found ${count}: ${JSON.stringify(from.slice(0, 60))}...`,
      )
    }
    body = body.split(from).join(to)
  }

  for (const symbol of EXPORTED_SYMBOLS) {
    const from = `export const ${symbol}`
    if (!body.includes(from)) {
      throw new Error(`expected to find "${from}" to drop its export keyword`)
    }
    body = body.split(from).join(`const ${symbol}`)
  }

  const generated = UPSTREAM_HEADER + body

  for (const needle of REPO_INTERNAL_PATH_NEEDLES) {
    if (generated.includes(needle)) {
      throw new Error(`generated upstream file still contains repo-internal path reference: ${needle}`)
    }
  }
  if (/\bexport const\b/.test(generated)) {
    throw new Error('generated upstream file still contains an `export const`')
  }
  if (generated.includes('IN-REPO SHIM')) {
    throw new Error('generated upstream file still contains a shim marker')
  }

  return generated
}

function main() {
  const sourceText = readFileSync(SOURCE_PATH, 'utf8')
  const generated = buildUpstreamSource(sourceText)

  const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT_PATH
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, generated)
  console.log(`wrote ${path.relative(REPO_ROOT, outputPath)}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
