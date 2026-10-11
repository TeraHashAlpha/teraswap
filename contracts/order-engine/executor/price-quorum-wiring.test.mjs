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
 *   4. the skip streak is reset ONLY once the price machinery releases the fill (after the
 *      single-source cap check) and on a successful fill, and dropped on expiry; the alert is gated
 *      on the tracker's `alert` flag with its own kind;
 *   4b. [Auditor round-1 M] a single-source fill DELAYED by the $ cap is a skip for streak purposes:
 *      it bumps the SAME per-order streak, escalates its alert to WARN at SKIP_ALERT_CYCLES, and
 *      ends in `continue`; a floor BREACH (its own per-cycle WARN) neither bumps nor resets it;
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

import { resolveFloorPrice, combineLegModes, recordQuorumSkip, clearQuorumSkips } from "./order-floor.js"

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

/** The single-source CAP-DELAY branch: from `if (!cap.ok) {` to the flagged single-source log that follows it. */
function capDelayBranch() {
  const block = dcaFloorBlock()
  const start = block.indexOf("if (!cap.ok) {")
  assert.notEqual(start, -1, "the cap-delay branch must be keyed on cap.ok")
  const marker = block.indexOf("DCA fill on a SINGLE price source", start)
  assert.notEqual(marker, -1, "the flagged single-source fill must follow the cap-delay branch")
  // cut at the START of the marker's line so the slice ends with the branch's closing brace
  return block.slice(start, block.lastIndexOf("\n", marker))
}

/** The floor BREACH branch: from `if (!floorDecision.ok) {` to the single-mode block that follows it. */
function breachBranch() {
  const block = dcaFloorBlock()
  const start = block.indexOf("if (!floorDecision.ok) {")
  assert.notEqual(start, -1, "the breach branch must be keyed on floorDecision.ok")
  const end = block.indexOf('if (quorumMode === "single") {', start)
  assert.notEqual(end, -1, "the single-mode block must follow the breach branch")
  return block.slice(start, end)
}

const EXECUTION_PATH_TOKENS = [
  "writeContract", "executeOrder", "sendTransaction", "fetchBestQuote", "simulateContract",
  "orderRetries", "handleExecutionFailure", "consecutiveExecFailures", "planFailureHandling",
  '"failed"', '"cancelled"', "cancel", "patchOrderRow", "recordExecution",
]

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
    const skipEnd = block.indexOf("// A price was resolved this cycle")
    assert.notEqual(skipEnd, -1, "the skip branch must end at the resolved-price marker")
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
    for (const forbidden of EXECUTION_PATH_TOKENS) {
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
  test("reset: ONLY once the price machinery releases the fill (after the cap check, after every hold-back branch) AND on a successful fill; dropped on expiry", () => {
    const block = dcaFloorBlock()
    const clears = [...block.matchAll(/clearQuorumSkips\(quorumSkips, dbOrder\.id\)/g)]
    assert.equal(clears.length, 1, "exactly one streak reset in the floor block")
    const capAt = block.indexOf("decideSingleSourceCap(")
    assert.notEqual(capAt, -1)
    assert.ok(clears[0].index > capAt, "the reset must FOLLOW the single-source cap check — otherwise a cap-delay could never extend the streak")
    assert.ok(clears[0].index > block.lastIndexOf("continue"), "the reset must follow every hold-back branch (skip / breach / cap-delay), so only a released fill resets")
    const successAt = src.indexOf("pinnedRouteReverts.delete(dbOrder.id)")
    assert.notEqual(successAt, -1)
    assert.match(src.slice(successAt, successAt + 300), /clearQuorumSkips\(quorumSkips, dbOrder\.id\)/, "a successful fill must reset the streak")
    assert.match(src, /updateOrderStatus\(dbOrder\.id, "expired"\)\s*\n\s*orderRetries\.delete\(dbOrder\.id\)\s*\n\s*quorumSkips\.delete\(dbOrder\.id\)/)
    assert.match(src, /const quorumSkips = new Map\(\)/)
  })
})

describe("4b. a single-source CAP-DELAY is a skip for streak purposes (Auditor round-1 M)", () => {
  test("cap-delay ⇒ recordQuorumSkip on the SAME per-order streak, unlock (active), skipped++, continue — and nothing else", () => {
    const branch = capDelayBranch()
    assert.match(branch, /const skip = recordQuorumSkip\(quorumSkips, dbOrder\.id\)/, "a cap-delay must bump the shared streak")
    assert.match(branch, /updateOrderStatus\(dbOrder\.id, "active"\)/)
    assert.match(branch, /skipped\+\+/)
    assert.match(branch.trimEnd(), /continue\s*\}\s*$/, "the branch must END with `continue` — nothing below it may run")
  })
  test("cap-delay alert: kind dca-floor-delay, WARN at SKIP_ALERT_CYCLES (tracker's alert flag), info (score 0) otherwise", () => {
    const branch = capDelayBranch()
    assert.match(branch, /kind: "dca-floor-delay"/)
    assert.match(branch, /skip\.alert \? TIER_WARN_THRESHOLD : 0/, "the delay alert must escalate on the streak, never stay a silent info forever")
    assert.match(branch, /skip\.count/, "the alert / log must carry the consecutive count")
  })
  test("the cap-delay branch touches no write, no failure ladder, no cancel, no execution", () => {
    const branch = stripComments(capDelayBranch())
    for (const forbidden of EXECUTION_PATH_TOKENS) {
      assert.ok(!branch.includes(forbidden), `cap-delay branch must not contain ${forbidden}`)
    }
  })
  test("a floor BREACH neither bumps nor resets the streak — it is a route-quality rejection with its own per-cycle WARN", () => {
    const branch = stripComments(breachBranch())
    assert.ok(!branch.includes("recordQuorumSkip"), "a breach is not a price-availability hold")
    assert.ok(!branch.includes("clearQuorumSkips"), "a breach does not release the fill either")
    assert.match(branch, /kind: "dca-floor-breach"[\s\S]*TIER_WARN_THRESHOLD/)
    assert.match(branch.trimEnd(), /continue\s*\}\s*$/)
  })
  test("behavioural: skip, cap-delay, skip on one order share ONE streak and alert exactly at SKIP_ALERT_CYCLES", () => {
    const skips = new Map()
    assert.deepEqual(recordQuorumSkip(skips, "o", 3), { count: 1, alert: false }, "cycle 1: quorum skip")
    assert.deepEqual(recordQuorumSkip(skips, "o", 3), { count: 2, alert: false }, "cycle 2: single above the cap — same streak")
    assert.deepEqual(recordQuorumSkip(skips, "o", 3), { count: 3, alert: true }, "cycle 3: quorum skip — WARN")
    assert.equal(clearQuorumSkips(skips, "o"), true, "a released fill resets it")
    assert.deepEqual(recordQuorumSkip(skips, "o", 3), { count: 1, alert: false })
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
