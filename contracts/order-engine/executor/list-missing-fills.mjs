// [CHORE-KEEPER-LIST-MISSING-FILLS] Read-only scan for OrderExecuted fills that exist on-chain but
// have no row in `order_executions` — sibling of backfill-execution.mjs, which needs exactly this
// script's `--out` file as its input list.
//
// Why this exists: `order_executions.next_best_out` was added by migration 20260723231005, which
// was never applied in Supabase from 2026-07-23 to 2026-09-14 — every keeper insert 400'd and was
// swallowed (see record-execution.js). Arbitrum's missed fills were recovered from pm2 logs; Base's
// cannot be (logs rotated). The chain is the only remaining source of truth for which tx hashes are
// missing, so this script re-derives them from `eth_getLogs` and diffs against Supabase.
//
// READ-ONLY: never writes to Supabase or the chain. Writes only the local `--out` file.
//
// Usage (load creds from your .env.executor / .env.executor.arbitrum first):
//   EXECUTOR_ENV_FILE=.env.executor node list-missing-fills.mjs --from-block <n> [--out <file>]
//   EXECUTOR_ENV_FILE=.env.executor node list-missing-fills.mjs --from-ts <unix> [--out <file>]
//
// Required env (no defaults — refuses naming the variable): RPC_URL, CHAIN_ID,
// ORDER_EXECUTOR_V3_ADDRESS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Optional env: LOGS_CHUNK (default 10000) — block range per eth_getLogs call.
//
// No secrets are ever printed: RPC_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are read but
// never logged, not even redacted — only their variable NAMES appear in refusal messages. The RPC
// host is masked as `<provider>` wherever it would otherwise appear.

// [KEEPER-ENV-ORDER] MUST stay the first import (see env.js) — loads .env.executor
// from cwd before the module-scope env reads below; explicit shell env still wins.
import "./env.js"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { writeFileSync } from "node:fs"
import { createPublicClient, http } from "viem"
import { verifyChainBinding, createRpcProbe, EXPECTED_ORDER_TYPEHASH_V3 } from "./chain-verify.js"
import { decodeOrderExecuted, ORDER_EXECUTED_EVENT } from "./record-execution.js"
import { parseChainIdEnv } from "./boot-config.js"

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
export const USAGE =
  "Usage: node list-missing-fills.mjs (--from-block <n> | --from-ts <unix>) [--out <file>]"

export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--from-block") args.fromBlock = argv[++i]
    else if (a === "--from-ts") args.fromTs = argv[++i]
    else if (a === "--out") args.out = argv[++i]
  }
  return args
}

// ── Never print RPC URLs, keys, or any env value — names only ──────────────────────────────────
// Deliberately unconditional: not "best-effort host extraction", a flat mask, so there is no parse
// path that could accidentally let part of the URL (and any embedded provider key) through.
export function maskRpcUrl() {
  return "<provider>"
}

// ── Formatting. Every function here takes ONLY chain-derived / decoded data as arguments — never
// RPC_URL or a Supabase credential — so leaking a secret through a print line is impossible by
// construction, not by discipline. ──────────────────────────────────────────────────────────────
export function formatBootLine({ chainId, address, codeSize }) {
  return `chain=${chainId} executor=${address} (${codeSize} bytes of code)`
}

export function formatTableHeader() {
  return ["block", "tx", "orderHash", "in/out", "recorded"].join("  |  ")
}

export function formatTableRow(row) {
  return [
    String(row.blockNumber),
    row.txHash,
    row.orderHash.slice(0, 10),
    `${row.amountIn}/${row.amountOut}`,
    row.recorded ? "yes" : "no",
  ].join("  |  ")
}

export function formatTable(rows) {
  return [formatTableHeader(), ...rows.map(formatTableRow)].join("\n")
}

export function formatSummaryLine({ onChainCount, recordedCount, missingCount }) {
  return `on-chain=${onChainCount} recorded=${recordedCount} missing=${missingCount}`
}

// ── Chunked eth_getLogs with a single bounded retry (halved chunk) on a range error ─────────────
// Covers [fromBlock, toBlock] with contiguous, non-overlapping chunks of `chunkSize` blocks. If a
// chunk's getLogs call throws (the shape of a provider "range too large" / "block range exceeded"
// error), retry ONCE for that same starting block at half the chunk size; a second failure
// propagates (the scan refuses rather than silently skipping a range). A successful retry does not
// change chunkSize for subsequent chunks — a single provider hiccup should not permanently shrink
// the whole scan.
export async function scanLogsChunked({ getLogs, fromBlock, toBlock, chunkSize, log = () => {} }) {
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error(`LOGS_CHUNK must be a positive number (received ${chunkSize})`)
  }
  const allLogs = []
  let cursor = fromBlock
  while (cursor <= toBlock) {
    const end = Math.min(cursor + chunkSize - 1, toBlock)
    try {
      const logs = await getLogs(cursor, end)
      allLogs.push(...logs)
      cursor = end + 1
    } catch (err) {
      const halfSize = Math.max(1, Math.floor(chunkSize / 2))
      const halfEnd = Math.min(cursor + halfSize - 1, toBlock)
      log(
        `[list-missing-fills] range error on ${cursor}-${end} (${err instanceof Error ? err.message : String(err)}), ` +
          `retrying ${cursor}-${halfEnd} at half chunk size`,
      )
      const logs = await getLogs(cursor, halfEnd)
      allLogs.push(...logs)
      cursor = halfEnd + 1
    }
  }
  return allLogs
}

// ── --from-ts → block number, by binary search over block timestamps ────────────────────────────
// Finds the first block whose timestamp is >= targetTs. getBlockTimestamp is injected so this is
// testable without a live RPC.
export async function resolveBlockFromTimestamp({ targetTs, latestBlock, getBlockTimestamp }) {
  let lo = 0
  let hi = latestBlock
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    const ts = await getBlockTimestamp(mid)
    if (ts < targetTs) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ── Decode a raw eth_getLogs log via the SAME decoder record-execution.js uses ──────────────────
export function buildRowFromLog(log, executorAddress) {
  const decoded = decodeOrderExecuted([log], executorAddress)
  if (!decoded) return null
  return {
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash,
    orderHash: decoded.orderHash,
    amountIn: decoded.amountIn,
    amountOut: decoded.amountOut,
  }
}

// ── Diff on-chain fills against the recorded tx_hash set, ordered by block ──────────────────────
export function diffMissing({ onChain, recordedTxHashes }) {
  const recordedSet = new Set(Array.from(recordedTxHashes, (h) => String(h).toLowerCase()))
  const rows = [...onChain]
    .sort((a, b) => a.blockNumber - b.blockNumber)
    .map((r) => ({ ...r, recorded: recordedSet.has(String(r.txHash).toLowerCase()) }))
  const missing = rows.filter((r) => !r.recorded)
  return {
    rows,
    missing,
    onChainCount: rows.length,
    recordedCount: rows.length - missing.length,
    missingCount: missing.length,
  }
}

// ── Paginated PostgREST fetch of every tx_hash already recorded ─────────────────────────────────
export async function fetchAllTxHashes(supabaseFetch, { pageSize = 1000 } = {}) {
  const hashes = []
  let offset = 0
  for (;;) {
    const res = await supabaseFetch(
      `order_executions?select=tx_hash&order=tx_hash.asc&limit=${pageSize}&offset=${offset}`,
    )
    if (!res.ok) {
      throw new Error(`order_executions tx_hash fetch failed: HTTP ${res.status}`)
    }
    const rows = await res.json()
    if (!Array.isArray(rows)) break
    for (const row of rows) if (row && row.tx_hash) hashes.push(row.tx_hash)
    if (rows.length < pageSize) break
    offset += pageSize
  }
  return hashes
}

// ── Verify chain binding, THEN scan — chain mismatch (or any chain-verify failure) throws before
// getLogs is ever called. ────────────────────────────────────────────────────────────────────────
export async function runScan({
  provider,
  chainId,
  executorAddress,
  expectedOrderTypehash,
  fromBlock,
  toBlock,
  getLogs,
  chunkSize,
  log = () => {},
}) {
  const verified = await verifyChainBinding({
    provider,
    chainId,
    contracts: [
      { label: "ORDER_EXECUTOR_V3_ADDRESS (v3)", address: executorAddress, expectedOrderTypehash },
    ],
    log,
  })
  const rawLogs = await scanLogsChunked({ getLogs, fromBlock, toBlock, chunkSize, log })
  const rows = rawLogs.map((lg) => buildRowFromLog(lg, executorAddress)).filter(Boolean)
  return { verified, rows }
}

// ── Entrypoint (never runs on import — only when invoked as `node list-missing-fills.mjs`) ──────

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`FATAL: ${name} must be set in the environment.`)
    process.exit(1)
  }
  return value
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.fromBlock && !args.fromTs) {
    console.error(USAGE)
    process.exit(1)
  }

  const RPC_URL = requireEnv("RPC_URL")
  const EXECUTOR_ADDRESS = requireEnv("ORDER_EXECUTOR_V3_ADDRESS")
  const SUPABASE_URL = requireEnv("SUPABASE_URL")
  const SUPABASE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY")

  const chainIdResult = parseChainIdEnv(process.env.CHAIN_ID)
  if (!chainIdResult.ok) {
    console.error(`FATAL: ${chainIdResult.reason}`)
    process.exit(1)
  }
  const CHAIN_ID = chainIdResult.chainId

  const rawChunk = Number(process.env.LOGS_CHUNK || "10000")
  const LOGS_CHUNK = Number.isFinite(rawChunk) && rawChunk > 0 ? rawChunk : 10000

  const client = createPublicClient({ transport: http(RPC_URL) })

  const latestBlock = Number(await client.getBlockNumber())
  let fromBlock
  if (args.fromBlock !== undefined) {
    fromBlock = Number(args.fromBlock)
    if (!Number.isFinite(fromBlock) || fromBlock < 0) {
      console.error(`FATAL: --from-block must be a non-negative integer (received ${args.fromBlock})`)
      process.exit(1)
    }
  } else {
    const targetTs = Number(args.fromTs)
    if (!Number.isFinite(targetTs)) {
      console.error(`FATAL: --from-ts must be a unix timestamp (received ${args.fromTs})`)
      process.exit(1)
    }
    fromBlock = await resolveBlockFromTimestamp({
      targetTs,
      latestBlock,
      getBlockTimestamp: async (n) => Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp),
    })
  }

  let scan
  try {
    scan = await runScan({
      provider: createRpcProbe(client),
      chainId: CHAIN_ID,
      executorAddress: EXECUTOR_ADDRESS,
      expectedOrderTypehash: EXPECTED_ORDER_TYPEHASH_V3,
      fromBlock,
      toBlock: latestBlock,
      chunkSize: LOGS_CHUNK,
      getLogs: (from, to) =>
        client.getLogs({
          address: EXECUTOR_ADDRESS,
          event: ORDER_EXECUTED_EVENT,
          fromBlock: BigInt(from),
          toBlock: BigInt(to),
        }),
      log: (msg) => console.log(msg),
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    console.error(`   Refusing to scan against ${maskRpcUrl()}.`)
    process.exit(1)
  }

  const contract = scan.verified.contracts[0]
  console.log(formatBootLine({ chainId: scan.verified.chainId, address: contract.address, codeSize: contract.codeSize }))

  async function supabaseFetch(path, options = {}) {
    return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    })
  }
  const recordedTxHashes = await fetchAllTxHashes(supabaseFetch)

  const { rows, missing, onChainCount, recordedCount, missingCount } = diffMissing({
    onChain: scan.rows,
    recordedTxHashes,
  })

  console.log(formatTable(rows))
  console.log(formatSummaryLine({ onChainCount, recordedCount, missingCount }))

  const outFile = args.out || `./missing-fills.${scan.verified.chainId}.txt`
  const outPath = resolve(process.cwd(), outFile)
  writeFileSync(outPath, missing.map((r) => r.txHash).join("\n") + (missing.length ? "\n" : ""))
  console.log(`Wrote ${missing.length} missing hash(es) to ${outFile}`)
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMainModule) {
  main().catch((err) => {
    console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
