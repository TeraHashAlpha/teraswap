// [PERF-KEEPER-IDLE-BACKOFF] Acceptance tests for event-watcher.js.
//
// Task 1 — ONE eth_getLogs per poll. Alchemy bills eth_getLogs per CALL, and the watcher issued one
// call per watched contract over the SAME block range (2 contracts ⇒ 5,760 calls/day at 30s, all
// while the keeper had nothing to do). viem accepts `address: Address[]`, so a single call with the
// full address list returns the union; the watcher then partitions by log.address (lower-cased)
// into the SAME per-contract buckets, processed in the SAME order, as the per-contract calls did.
//
// The fake client below emulates the RPC's address filter (string OR array), so the fixture set —
// mixed across both contracts and one NON-watched address, interleaved by block — exercises the
// array form for real. "Today's output" (the label/event/block sequence the per-contract loop
// produced) was captured by running this file against the pre-change watcher and is pinned as
// EXPECTED_SEQUENCE_TODAY: the partition test passed before the change and must still pass after.
//
// Telegram is stubbed by pointing sendTelegramAlert at a fake fetch (dummy token/chat) — no real
// network call is ever made; the fake records each message body so the alert path is exercised.

import { test, describe, mock } from "node:test"
import assert from "node:assert/strict"
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, keccak256, toHex } from "viem"

process.env.TELEGRAM_BOT_TOKEN = "test-token-never-used"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "1"

const { startEventWatcher } = await import("./event-watcher.js")

// ── Fixture: two watched contracts (checksum-cased, as env vars usually are) + one stranger ────
const ORDER_EXECUTOR = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa"
const FEE_COLLECTOR = "0xBbBBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB"
const STRANGER = "0xcccccccccccccccccccccccccccccccccccccccc"
const CONTRACTS = [
  { address: ORDER_EXECUTOR, label: "OrderExecutor" },
  { address: FEE_COLLECTOR, label: "FeeCollector" },
]

const ADMIN = "0x1111111111111111111111111111111111111111"
const ROUTER = "0x2222222222222222222222222222222222222222"
const ACTION_1 = keccak256(toHex("action-1"))
const ACTION_2 = keccak256(toHex("action-2"))
const ACTION_HASH = keccak256(toHex("action-hash"))

const EV_PAUSED = parseAbiItem("event Paused(address indexed admin)")
const EV_ROUTER = parseAbiItem("event RouterWhitelisted(address indexed router, bool status)")
const EV_QUEUED = parseAbiItem("event TimelockQueued(bytes32 indexed actionId, bytes32 actionHash, uint256 readyAt)")
const EV_FC_EXECUTED = parseAbiItem("event TimelockExecuted(bytes32 indexed actionId)") // FeeCollector variant

let txCounter = 0
/** A viem-shaped log as eth_getLogs returns it: LOWER-CASE address, topics, data, block, tx hash. */
function makeLog({ address, blockNumber, abi, args, data = "0x" }) {
  txCounter += 1
  return {
    address: address.toLowerCase(),
    topics: encodeEventTopics({ abi: [abi], eventName: abi.name, args }),
    data,
    blockNumber: BigInt(blockNumber),
    transactionHash: `0x${String(txCounter).padStart(64, "0")}`,
    logIndex: txCounter,
  }
}

// Interleaved by block exactly as ONE union call would return them.
const ALL_LOGS = [
  makeLog({ address: ORDER_EXECUTOR, blockNumber: 101, abi: EV_PAUSED, args: { admin: ADMIN } }),
  makeLog({ address: FEE_COLLECTOR, blockNumber: 101, abi: EV_FC_EXECUTED, args: { actionId: ACTION_1 } }),
  makeLog({ address: STRANGER, blockNumber: 101, abi: EV_PAUSED, args: { admin: ADMIN } }),
  makeLog({
    address: ORDER_EXECUTOR,
    blockNumber: 102,
    abi: EV_ROUTER,
    args: { router: ROUTER },
    data: encodeAbiParameters([{ type: "bool" }], [true]),
  }),
  makeLog({ address: FEE_COLLECTOR, blockNumber: 103, abi: EV_FC_EXECUTED, args: { actionId: ACTION_2 } }),
  makeLog({
    address: ORDER_EXECUTOR,
    blockNumber: 103,
    abi: EV_QUEUED,
    args: { actionId: ACTION_1 },
    data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [ACTION_HASH, 1_900_000_000n]),
  }),
]

/**
 * Captured from the pre-change watcher (one getLogs per contract, contracts in order): every
 * OrderExecutor log first, then every FeeCollector log, each bucket in block order. The stranger's
 * log never appears — the RPC filter excludes it.
 */
const EXPECTED_SEQUENCE_TODAY = [
  { label: "OrderExecutor", name: "Paused", block: 101n },
  { label: "OrderExecutor", name: "RouterWhitelisted", block: 102n },
  { label: "OrderExecutor", name: "TimelockQueued", block: 103n },
  { label: "FeeCollector", name: "TimelockExecuted", block: 101n },
  { label: "FeeCollector", name: "TimelockExecuted", block: 103n },
]

/** Emulates the node: honours `address` as a string OR an array, plus the block range. */
function fakePublicClient({ blocks }) {
  let blockCalls = 0
  const getLogsCalls = []
  return {
    getLogsCalls,
    blockNumberCalls: () => blockCalls,
    client: {
      async getBlockNumber() {
        const n = blocks[Math.min(blockCalls, blocks.length - 1)]
        blockCalls += 1
        return n
      },
      async getLogs(params) {
        getLogsCalls.push(params)
        const wanted = (Array.isArray(params.address) ? params.address : [params.address]).map((a) =>
          a.toLowerCase(),
        )
        return ALL_LOGS.filter(
          (l) =>
            wanted.includes(l.address) && l.blockNumber >= params.fromBlock && l.blockNumber <= params.toBlock,
        )
      },
    },
  }
}

/** Let the un-awaited async poll() run to completion (its awaits all resolve on the microtask queue). */
async function flush(turns = 40) {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r))
}

/** Parse "[EVENT-WATCHER] [label] Name at block N" console lines into the processed sequence. */
function processedSequence(logMock) {
  const out = []
  for (const call of logMock.mock.calls) {
    const m = /^\[EVENT-WATCHER\] \[(\w+)\] (\w+) at block (\d+)$/.exec(String(call.arguments[0]))
    if (m) out.push({ label: m[1], name: m[2], block: BigInt(m[3]) })
  }
  return out
}

async function runOnePoll() {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] })
  const logMock = mock.method(console, "log", () => {})
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  const fake = fakePublicClient({ blocks: [100n, 103n] })
  const watcher = startEventWatcher(fake.client, CONTRACTS, null)
  try {
    await flush() // initial poll: records block 100, no getLogs
    mock.timers.tick(30_000) // second poll: 101..103
    await flush()
    return { fake, sent, sequence: processedSequence(logMock) }
  } finally {
    watcher.stop()
    fetchMock.mock.restore()
    logMock.mock.restore()
    mock.timers.reset()
  }
}

describe("event-watcher: one eth_getLogs per poll (Task 1)", () => {
  test("a mixed log set partitions into today's per-contract buckets, in today's order (captured pre-change)", async () => {
    const { sequence, sent } = await runOnePoll()
    assert.deepEqual(sequence, EXPECTED_SEQUENCE_TODAY)
    // Every alert carries its contract label — attribution is unchanged.
    assert.equal(sent.length, EXPECTED_SEQUENCE_TODAY.length)
    for (let i = 0; i < sent.length; i += 1) {
      assert.ok(sent[i].includes(`[${EXPECTED_SEQUENCE_TODAY[i].label}] On-chain Event`), `alert ${i} label`)
    }
    // A log from an address we do not watch is never processed.
    assert.equal(sequence.some((s) => s.label !== "OrderExecutor" && s.label !== "FeeCollector"), false)
  })

  test("the poll issues exactly ONE getLogs, with the FULL address array and the same range", async () => {
    const { fake } = await runOnePoll()
    assert.equal(fake.getLogsCalls.length, 1, `expected 1 getLogs call, got ${fake.getLogsCalls.length}`)
    const [call] = fake.getLogsCalls
    assert.deepEqual(call.address, CONTRACTS.map((c) => c.address), "all watched addresses in one call")
    assert.equal(call.fromBlock, 101n)
    assert.equal(call.toBlock, 103n)
    assert.equal(fake.blockNumberCalls(), 2, "one eth_blockNumber per poll, as before")
  })
})
