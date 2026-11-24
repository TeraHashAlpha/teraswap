// [A92 S-4] (Low, new in round 1) redactError calls extractRevertData (revert-decode.js), which walked the `cause` chain
// with no depth limit: a `seen` set stops a cycle, but not a `cause` getter that returns a FRESH object on every read
// (every link is new). Walking it exhausted the heap (exit 134). The walk stops at REVERT_DATA_MAX_DEPTH (16) links.
//
// The hostile chain counts its reads and, past 100,000, throws: without the cap the walk then fails this test with a
// throw (or a read count far over the bound) instead of taking the test process down with it. The capped walk never
// gets near it.
//
// Run: node --test contracts/order-engine/executor/redact-a92-s4-cause-depth.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"

import { extractRevertData, REVERT_DATA_MAX_DEPTH } from "./revert-decode.js"
import { redactError } from "./redact.js"

const TRIPWIRE = 100_000
const BOUND_MS = 50

/** An error whose `cause` getter returns a fresh object, with the same getter, on every read. */
function endlessChain() {
  const counter = { reads: 0 }
  const withCause = (o) =>
    Object.defineProperty(o, "cause", {
      get() {
        counter.reads++
        if (counter.reads > TRIPWIRE) throw new Error("tripwire: the cause walk did not stop")
        return withCause({ name: "Error", message: `link ${counter.reads}` })
      },
    })
  return { err: withCause(new Error("outer")), counter }
}

/** A plain chain of `links` errors; the last one carries revert data. */
function chainWithDataAt(links) {
  let e = { name: "Inner", message: "inner", data: "0xbb2875c3" }
  for (let i = 1; i < links; i++) e = { name: `Wrapper${i}`, message: "wrapper", cause: e }
  return e
}

describe("[A92 S-4] the cause walk is bounded", () => {
  test("the cap is 16 links", () => {
    assert.equal(REVERT_DATA_MAX_DEPTH, 16)
  })

  test(`extractRevertData on an endless chain returns null within ${BOUND_MS} ms, reading at most 16 causes`, () => {
    const { err, counter } = endlessChain()
    const t = performance.now()
    const out = extractRevertData(err)
    const ms = performance.now() - t
    assert.equal(out, null)
    assert.ok(counter.reads <= REVERT_DATA_MAX_DEPTH, `${counter.reads} cause reads`)
    assert.ok(ms < BOUND_MS, `${ms.toFixed(1)} ms`)
  })

  test(`redactError on an endless chain returns its text within ${BOUND_MS} ms`, () => {
    redactError(new Error("warm-up")) // first call compiles the module's patterns; not part of what is measured
    const { err, counter } = endlessChain()
    const t = performance.now()
    const out = redactError(err)
    const ms = performance.now() - t
    assert.equal(out, "outer")
    // extractRevertData's walk plus redactError's own reason walk (revertReason), each at most 16 links.
    assert.ok(counter.reads <= 2 * REVERT_DATA_MAX_DEPTH, `${counter.reads} cause reads`)
    assert.ok(ms < BOUND_MS, `${ms.toFixed(1)} ms`)
  })

  test("revert data on link 16 is still found; on link 17 the walk has stopped", () => {
    assert.equal(extractRevertData(chainWithDataAt(16)), "0xbb2875c3")
    assert.equal(extractRevertData(chainWithDataAt(17)), null)
  })

  test("a cycle still ends the walk at the repeated link", () => {
    const a = { name: "A", message: "a" }
    const b = { name: "B", message: "b", cause: a }
    a.cause = b
    assert.equal(extractRevertData(a), null)
  })
})
