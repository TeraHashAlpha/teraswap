/**
 * [fix/keeper-alert-cooldown-and-dca-debug-read] The per-order "Debug: read current Chainlink
 * price" block in executor.js (right before canExecute) called latestRoundData on
 * orderStruct.priceFeed for EVERY order. A DCA order has priceFeed = the zero address, so every
 * DCA cycle logged `Could not read Chainlink price: … returned no data ("0x")` — noise that reads
 * like a feed outage (seen 2026-09-13, Arbitrum keeper day one). Now: zero address ⇒ no read and
 * one short line; a real feed (Limit / SL / TP) ⇒ the read and both log lines, exactly as before.
 *
 * executor.js auto-runs main() on import, so — like retry-cap-restart.test.mjs and
 * idle-backoff.test.mjs — the block is located by its source anchors. Unlike those, the REAL block
 * text is then executed (an AsyncFunction over its free identifiers) against a recording
 * publicClient, so what is proven is the shipped code, not a model of it. A new free identifier in
 * the block fails these tests with a ReferenceError — add it to the parameter list.
 *
 * Run: node --test contracts/order-engine/executor/chainlink-debug-read.test.mjs
 */

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { getAddress, zeroAddress } from "viem"

const src = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")

const FROM = "// Debug: read current Chainlink price"
const TO = "// Check via contract"

/** The debug-read block: from its comment up to (not including) the canExecute comment. */
function sliceBlock() {
  const a = src.indexOf(FROM)
  assert.ok(a >= 0, `anchor not found in executor.js: ${JSON.stringify(FROM)}`)
  const b = src.indexOf(TO, a + FROM.length)
  assert.ok(b >= 0, `end anchor not found after ${JSON.stringify(FROM)}: ${JSON.stringify(TO)}`)
  assert.equal(src.indexOf(FROM, a + 1), -1, "the debug-read block must exist exactly once")
  return src.slice(a, b)
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const runBlock = new AsyncFunction(
  "publicClient", "orderStruct", "PRICE_FEED_ABI", "log", "zeroAddress",
  sliceBlock(),
)

// Identity only — the block must pass THIS object to readContract.
const PRICE_FEED_ABI = [{ name: "latestRoundData", type: "function", stateMutability: "view", inputs: [], outputs: [] }]
// Synthetic, non-zero, checksummed feed address — built, not typed; no real feed is needed here.
const FEED = getAddress(`0x${"11".repeat(20)}`)

function harness({ answer = 250_000_000_000n, fail = false } = {}) {
  const reads = []
  const lines = []
  const publicClient = {
    async readContract(args) {
      reads.push(args)
      if (fail) throw new Error('The contract function "latestRoundData" returned no data ("0x").')
      return [1n, answer, 0n, 0n, 1n]
    },
  }
  return { reads, lines, publicClient, log: (m) => lines.push(m) }
}

// What executor.js builds: priceFeed = getAddress(od.priceFeed) — the zero address for a DCA order.
const DCA_STRUCT = { priceFeed: getAddress(zeroAddress), targetPrice: 0n, condition: 0 }
const LIMIT_STRUCT = { priceFeed: FEED, targetPrice: 250_000_000_000n, condition: 1 }

describe("DCA order (priceFeed = zero address) — the debug read is skipped", () => {
  test("no latestRoundData read is made against the zero address", async () => {
    const h = harness()
    await runBlock(h.publicClient, DCA_STRUCT, PRICE_FEED_ABI, h.log, zeroAddress)
    assert.equal(h.reads.length, 0, `readContract must not be called; got ${JSON.stringify(h.reads)}`)
  })

  test("logs exactly one short line — `  Price feed: none (DCA)` — and never the 'Could not read' error line", async () => {
    const h = harness()
    await runBlock(h.publicClient, DCA_STRUCT, PRICE_FEED_ABI, h.log, zeroAddress)
    assert.deepEqual(h.lines, ["  Price feed: none (DCA)"])
    assert.ok(!h.lines.some((l) => l.includes("Could not read Chainlink price")))
  })
})

describe("Limit / SL / TP order (real priceFeed) — existing behaviour kept", () => {
  test("latestRoundData IS read on orderStruct.priceFeed with PRICE_FEED_ABI, and both debug lines are logged verbatim", async () => {
    const h = harness({ answer: 250_000_000_000n })
    await runBlock(h.publicClient, LIMIT_STRUCT, PRICE_FEED_ABI, h.log, zeroAddress)

    assert.equal(h.reads.length, 1, "exactly one read")
    assert.equal(h.reads[0].address, FEED)
    assert.equal(h.reads[0].functionName, "latestRoundData")
    assert.equal(h.reads[0].abi, PRICE_FEED_ABI, "the executor's own ABI object is passed")
    assert.deepEqual(h.lines, [
      `  Chainlink price from ${FEED.slice(0, 10)}...: 250000000000 (=$2500)`,
      `  Target: 250000000000 (=$2500), Condition: BELOW`,
    ])
  })

  test("a failing read still logs the 'Could not read Chainlink price' line and never throws", async () => {
    const h = harness({ fail: true })
    await runBlock(h.publicClient, LIMIT_STRUCT, PRICE_FEED_ABI, h.log, zeroAddress)
    assert.equal(h.reads.length, 1)
    assert.equal(h.lines.length, 1)
    assert.match(h.lines[0], /^ {2}Could not read Chainlink price: The contract function "latestRoundData" returned no data/)
    assert.ok(!h.lines.some((l) => l.includes("Price feed: none")), "a real feed never gets the DCA line")
  })
})

describe("executor.js wiring", () => {
  test("zeroAddress comes from viem's import list — no hand-typed zero address in the block", () => {
    const viemImport = src.match(/import \{([^}]*)\} from "viem"/)
    assert.ok(viemImport, "could not locate the viem import")
    assert.match(viemImport[1], /\bzeroAddress\b/, "executor.js must import zeroAddress from viem")
    assert.ok(!/0x0{40}/i.test(sliceBlock()), "the block compares against viem's zeroAddress, not a literal")
  })

  test("the zero-address guard decides BEFORE the try/catch read, and the block still sits directly ahead of canExecute", () => {
    const block = sliceBlock()
    const guard = block.indexOf("orderStruct.priceFeed === zeroAddress")
    const read = block.indexOf("try {")
    assert.ok(guard >= 0, "guard missing")
    assert.ok(read >= 0, "the try/catch read is gone")
    assert.ok(guard < read, "the guard must come before the read")
    const after = src.slice(src.indexOf(FROM) + block.length)
    assert.match(after, /^\/\/ Check via contract[^\n]*\n\s*const \[canExec, reason\] = await publicClient\.readContract\(/)
  })
})
