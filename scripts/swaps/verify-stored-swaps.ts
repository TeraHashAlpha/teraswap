#!/usr/bin/env tsx
/**
 * [ADR-029 section 4, details F] Check the swaps rows ALREADY STORED against the chain, with the same function the
 * route uses, and report. Nothing is deleted, and nothing is written unless --apply is given.
 *
 *   npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts < rows.json      (report, from an export)
 *   npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts --from-db        (report, from the database)
 *   npx --yes tsx --tsconfig tsconfig.json scripts/swaps/verify-stored-swaps.ts --from-db --apply
 *
 * stdout: JSON lines. First how the run is set up (mode; per chain, the NAME of the environment variable the RPC URL
 * comes from and whether a FeeCollector is configured), then one line per row
 *   { id, chain, decision, outcome, kind | reason, derived: { tokenIn, amountIn, tokenOut, amountOut, source }, ... }
 * and last a summary. `decision` is what --apply would do: "mark", or why not (verify-stored-swaps-lib.ts).
 * --apply sets verified_at and verified_kind on "mark" rows only, each only while it is still unverified.
 *
 * It never prints a key or an RPC URL: the database is named by SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY and read
 * from the environment, the chain endpoints by RPC_URL_<chain id>, and failures are printed as fixed words.
 * It ends by setting process.exitCode, never by calling process.exit, so a long report is not cut short when stdout is
 * a pipe. Run it only from the owner's terminal: this repository's agents never call a production database.
 */
import { createClient } from '@supabase/supabase-js'
import { getSupportedChainIds } from '@/lib/chains/registry'
import { serverOnlyRpcSource } from '@/lib/rpc-env'
import { feeCollectorsOf, verifySwapOnChain } from '@/lib/swap-verify/verify-swap-on-chain'
import { main, type SwapsDb } from './verify-stored-swaps-lib'

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

/** Writes one line and waits for the stream when it asks to (a pipe that is read slowly). */
function out(line: string): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.write(`${line}\n`)) resolve()
    else process.stdout.once('drain', () => resolve())
  })
}

function database(): SwapsDb | null {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } }) as unknown as SwapsDb
}

/** Environment NAMES and public contract addresses only. */
function describe(): Array<Record<string, unknown>> {
  return getSupportedChainIds().flatMap((chain) => {
    const collectors = feeCollectorsOf(chain)
    return [
      { info: 'rpc', chain, source: serverOnlyRpcSource(chain) },
      { info: 'fee_collector', chain, configured: collectors.current !== null, address: collectors.current, v1: collectors.v1 },
    ]
  })
}

// The stored rows are old: a transaction the node does not have is not "not there yet". A null answer is still asked
// once more (chain-read.ts), with no pause between the two reads.
process.env.SWAP_VERIFY_MISSING_RETRY_MS = '0'

void main({
  argv: process.argv.slice(2),
  readStdin,
  out,
  err: (line) => console.error(line),
  verify: (input) => verifySwapOnChain(input),
  db: database,
  describe,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}).then(
  (code) => {
    process.exitCode = code
  },
  () => {
    // main() reports its own failures; this is only for a bug in it. Fixed words, no error text.
    console.error('verify-stored-swaps: failed')
    process.exitCode = 1
  },
)
