/**
 * [ADR-024 / feat/keeper-price-quorum] executor.js wiring of the DCA price quorum.
 *
 * executor.js cannot be imported (it auto-runs main()), so — like arbitrum-plumbing.test.mjs and
 * eth-usd-feed.test.mjs — the properties that make the owner's decisions hold at the call site are
 * asserted against the file's SOURCE, scoped to the DCA floor block:
 *
 *   1. both legs are quoted through the per-cycle context and resolved with resolveFloorPrice /
 *      combineLegModes;
 *   2. the SKIP branch NEVER reaches the execute path: it unlocks, counts, `continue`s — before
 *      fetchBestQuote / dcaDueSec / any write — and never touches the failure ladder or cancels;
 *   3. single mode uses the TIGHTER band and the SAME cap source as before (getFailOpenMaxUsd);
 *   4. the skip streak is reset when a price resolves and on a successful fill, and dropped on
 *      expiry; the alert is gated on the tracker's `alert` flag with its own kind;
 *   5. the old blind-fill plumbing (fetchReferencePriceUsd, classifyReference, decideFailOpen,
 *      inline DefiLlama) is gone from executor.js.
 *
 * Plus a behavioural proof over the pure pieces that an empty / disagreeing quote set can only ever
 * produce a skip, i.e. no price ⇒ no fill, with zero network.
 *
 * Run: node --test contracts/order-engine/executor/price-quorum-wiring.test.mjs
 */
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { resolveFloorPrice, combineLegModes } from "./order-floor.js"

const src = readFileSync(new URL("./executor.js", import.meta.url), "utf-8")

/** The DCA floor block: from the quorum log line to the deviation gate's dueSec. */
function dcaFloorBlock() {
  const start = src.indexOf("DCA price quorum:")
  assert.notEqual(start, -1, "executor.js must log the per-fill quorum line")
  const end = src.indexOf("const dueSec = dcaDueSec(dbOrder)", start)
  assert.notEqual(end, -1, "the deviation gate must follow the floor block")
  return src.slice(start, end)
}

/** The SKIP branch: from `if (skipReason !== null) {` to the streak reset that follows it. */
function skipBranch() {
  const block = dcaFloorBlock()
  const start = block.indexOf("if (skipReason !== null) {")
  assert.notEqual(start, -1, "the skip branch must be keyed on skipReason")
  const end = block.indexOf("// A price was resolved this cycle", start)
  assert.notEqual(end, -1, "a resolved price must reset the streak right after the skip branch")
  return block.slice(start, end)
}

/** Source with full-line comments removed, so a forbidden token in a COMMENT does not count. */
function stripComments(s) {
  return s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
}

describe("1. both legs are quoted and resolved through the quorum", () => {
  test("per-cycle context created ONCE before the order loop, with every active DCA token registered", () => {
    const ctxAt = src.indexOf("createCycleQuoteContext({")
    const loopAt = src.indexOf("for (const dbOrder of orders)")
    assert.notEqual(ctxAt, -1)
    assert.ok(ctxAt < loopAt, "the quote context must exist before the loop")
    assert.equal(src.split("createCycleQuoteContext(").length - 1, 1, "exactly one context per cycle")
    assert.match(src, /quoteCtx\.registerTokens\(\s*orders\.filter\(\(o\) => o\.order_type === "dca"\)\.flatMap\(\(o\) => \[o\.order_data\?\.tokenIn, o\.order_data\?\.tokenOut\]\)/)
  })
  test("tokenIn and tokenOut are each quoted and resolved with their own leg", () => {
    const block = src.slice(src.indexOf("if (isDca) {"), src.indexOf("const dueSec = dcaDueSec(dbOrder)"))
    assert.match(block, /quoteCtx\.legQuotes\(orderStruct\.tokenIn\)/)
    assert.match(block, /quoteCtx\.legQuotes\(orderStruct\.tokenOut\)/)
    assert.match(block, /const floorIn = resolveFloorPrice\("in", quotesIn\)/)
    assert.match(block, /const floorOut = resolveFloorPrice\("out", quotesOut\)/)
    assert.match(block, /const quorumMode = combineLegModes\(floorIn\.mode, floorOut\.mode\)/)
  })
})

describe("2. the SKIP branch never reaches the execute path", () => {
  test("skip ⇒ count, log, unlock (active), skipped++, continue — and nothing else", () => {
    const branch = skipBranch()
    assert.match(branch, /recordQuorumSkip\(quorumSkips, dbOrder\.id\)/)
    assert.match(branch, /updateOrderStatus\(dbOrder\.id, "active"\)/)
    assert.match(branch, /skipped\+\+/)
    assert.match(branch.trimEnd(), /continue\s*\}\s*$/, "the branch must END with `continue` — nothing below it may run")
  })
  test("the skip branch precedes every execution-path call in the DCA block", () => {
    const block = dcaFloorBlock()
    const skipEnd = block.indexOf("clearQuorumSkips(quorumSkips, dbOrder.id)")
    for (const needle of ["fetchBestQuote(", "decideDcaExecution(", "computeReferenceExpectedOut({", "decideFloor({"]) {
      const at = src.indexOf(needle, src.indexOf("DCA price quorum:"))
      if (needle === "computeReferenceExpectedOut({" || needle === "decideFloor({") {
        // the reference is computed BEFORE the skip decision (so an unusable one can skip too) but
        // decideFloor — the gate to execution — must come after.
        if (needle === "decideFloor({") assert.ok(block.indexOf(needle) > skipEnd, `${needle} must be after the skip branch`)
        continue
      }
      assert.ok(at > src.indexOf("DCA price quorum:") + skipEnd, `${needle} must come after the skip branch`)
    }
  })
  test("the skip branch touches no write, no failure ladder, no cancel, no execution", () => {
    const branch = stripComments(skipBranch())
    for (const forbidden of [
      "writeContract", "executeOrder", "sendTransaction", "fetchBestQuote", "simulateContract",
      "orderRetries", "handleExecutionFailure", "consecutiveExecFailures", "planFailureHandling",
      '"failed"', '"cancelled"', "cancel", "patchOrderRow", "recordExecution",
    ]) {
      assert.ok(!branch.includes(forbidden), `skip branch must not contain ${forbidden}`)
    }
  })
  test("an unusable reference (prices resolved, floor not computable) is a skip too — never a blind fill", () => {
    const block = dcaFloorBlock()
    assert.match(block, /if \(referenceExpectedOut === null \|\| referenceExpectedOut <= 0n\) \{\s*skipReason = /)
  })
  test("the quorum block never cancels an order (status only ever returns to 'active')", () => {
    const block = dcaFloorBlock()
    const statuses = [...block.matchAll(/updateOrderStatus\(dbOrder\.id, "([a-z_]+)"\)/g)].map((m) => m[1])
    assert.ok(statuses.length >= 3, "expected the skip / breach / cap-delay unlocks")
    assert.deepEqual([...new Set(statuses)], ["active"])
    assert.ok(!/cancel/i.test(block), "no cancel anywhere in the quorum block")
  })
})

describe("3. single mode: tighter band, SAME cap source", () => {
  test("band = singleSourceFloorBps(getFloorMaxSlippageBps()) only in single mode", () => {
    assert.match(dcaFloorBlock(), /const floorBps = quorumMode === "single" \? singleSourceFloorBps\(getFloorMaxSlippageBps\(\)\) : getFloorMaxSlippageBps\(\)/)
  })
  test("cap = getFailOpenMaxUsd() (unchanged source), sized from the 'in' leg, delay above / flagged within", () => {
    const block = dcaFloorBlock()
    assert.match(block, /decideSingleSourceCap\(\{ notionalUsd, maxUsd: getFailOpenMaxUsd\(\) \}\)/)
    assert.match(block, /const notionalUsd = \(Number\(netAmount\) \/ 10 \*\* srcDecimals\) \* floorIn\.price/)
    assert.match(block, /kind: "dca-floor-single-source"/)
    assert.match(block, /kind: "dca-floor-delay"/)
  })
})

describe("4. skip streak lifecycle + alert", () => {
  test("alert kind dca-price-quorum-skip, gated on the tracker's alert flag, warn tier", () => {
    const branch = skipBranch()
    assert.match(branch, /if \(skip\.alert\) \{[\s\S]*kind: "dca-price-quorum-skip"[\s\S]*TIER_WARN_THRESHOLD/)
  })
  test("reset: when a price resolves (right after the skip branch) AND on a successful fill; dropped on expiry", () => {
    assert.match(dcaFloorBlock(), /continue\s*\}\s*\/\/[^\n]*\n\s*clearQuorumSkips\(quorumSkips, dbOrder\.id\)/)
    const successAt = src.indexOf("pinnedRouteReverts.delete(dbOrder.id)")
    assert.notEqual(successAt, -1)
    assert.match(src.slice(successAt, successAt + 300), /clearQuorumSkips\(quorumSkips, dbOrder\.id\)/, "a successful fill must reset the streak")
    assert.match(src, /updateOrderStatus\(dbOrder\.id, "expired"\)\s*\n\s*orderRetries\.delete\(dbOrder\.id\)\s*\n\s*quorumSkips\.delete\(dbOrder\.id\)/)
    assert.match(src, /const quorumSkips = new Map\(\)/)
  })
})

describe("5. the blind-fill plumbing is gone", () => {
  test("no fetchReferencePriceUsd / classifyReference / decideFailOpen / inline DefiLlama / fill-unverified", () => {
    for (const gone of ["async function fetchReferencePriceUsd", "classifyReference(", "decideFailOpen(", "coins.llama.fi", '"dca-floor-unverified"', "ETH_PRICED_ADDRESSES.has"]) {
      assert.ok(!src.includes(gone), `executor.js must no longer contain ${gone}`)
    }
  })
})

describe("behavioural: no price ⇒ no fill (pure pieces, zero network)", () => {
  test("every input class the owner called out resolves to a mode the executor cannot execute on blindly", () => {
    const skip = (legs) => combineLegModes(resolveFloorPrice("in", legs.in, { toleranceBps: 300 }).mode, resolveFloorPrice("out", legs.out, { toleranceBps: 300 }).mode)
    const q = (p, s) => ({ price: p, ts: 1, source: s })
    assert.equal(skip({ in: [], out: [] }), "skip", "0 sources")
    assert.equal(skip({ in: [q(3000, "chainlink"), q(3000, "defillama")], out: [] }), "skip", "one leg unpriced")
    assert.equal(skip({ in: [q(3000, "chainlink"), q(3300, "defillama")], out: [q(1, "chainlink"), q(1, "defillama")] }), "skip", "2 disagree, no third")
    assert.equal(skip({ in: [q(3000, "chainlink")], out: [q(1, "chainlink"), q(1, "defillama")] }), "single", "exactly one source ⇒ capped + flagged, never unbounded")
    assert.equal(skip({ in: [q(3000, "chainlink"), q(3300, "defillama"), q(3010, "coingecko")], out: [q(1, "chainlink"), q(1, "defillama")] }), "quorum", "third breaks the tie")
  })
})
