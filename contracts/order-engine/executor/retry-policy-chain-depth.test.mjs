// [A73d L-1] collectErrorText and collectErrorMeta read the SAME number of `cause` links.
//
// collectErrorMeta (the cause rules: names, statuses, codes, revert data, text) stops at 10 links;
// collectErrorText (isFloorRevert, classifyFailure's permanent signatures) walked the whole chain.
// The two halves of one classification could therefore disagree about the same error: a signature
// buried at link 15 decided a terminal `failed` although the meta walk never saw that link — and an
// attacker-shaped (or merely pathological) chain made the text walk unbounded.
//
// Chains are real viem BaseError objects (shortMessage per link, `cause` nesting as viem builds it).
//
// Run: node --test contracts/order-engine/executor/retry-policy-chain-depth.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { BaseError } from "viem"
import { classifyFailure, collectErrorText, isFloorRevert } from "./retry-policy.js"

/** A chain of `n` real viem errors, outermost first; link `at` carries `marker`, the rest `link-<i>`. */
function chain(n, { at = -1, marker = "" } = {}) {
  let e
  for (let i = n - 1; i >= 0; i--) e = new BaseError(i === at ? marker : `link-${i}`, e === undefined ? undefined : { cause: e })
  return e
}

/** The distinct `link-<i>` ids in the text, in order (a viem link's message repeats its shortMessage). */
const linkIds = (text) => [...new Set(text.match(/link-\d+/g) ?? [])]

describe("[A73d L-1] the text walk stops at the same depth as the meta walk (10 links)", () => {
  test("a 60-link chain contributes exactly its first 10 links", () => {
    const text = collectErrorText(chain(60))
    assert.deepEqual(linkIds(text), Array.from({ length: 10 }, (_, i) => `link-${i}`), text)
  })

  test("a 10-link chain is read in full; an 11th link is not", () => {
    assert.ok(collectErrorText(chain(10)).includes("link-9"))
    assert.ok(!collectErrorText(chain(11)).includes("link-10"))
  })

  test("a very long chain is bounded, not walked to its end", () => {
    assert.equal(linkIds(collectErrorText(chain(5_000))).length, 10)
  })
})

describe("[A73d L-1] what the text walk feeds is bounded the same way", () => {
  test("isFloorRevert: InsufficientOutput() at link 5 is seen, at link 12 is not", () => {
    assert.equal(isFloorRevert({ err: chain(20, { at: 5, marker: "reverted with InsufficientOutput()" }) }), true)
    assert.equal(isFloorRevert({ err: chain(20, { at: 12, marker: "reverted with InsufficientOutput()" }) }), false)
  })

  test("classifyFailure: a permanent signature at link 5 is terminal, at link 12 is not", () => {
    const near = classifyFailure({ err: chain(20, { at: 5, marker: "ERC20: insufficient allowance" }) })
    assert.deepEqual(near, { terminal: true, reason: near.reason })
    assert.ok(near.reason, "a named reason")
    assert.deepEqual(classifyFailure({ err: chain(20, { at: 12, marker: "ERC20: insufficient allowance" }) }), { terminal: false, reason: null })
  })

  test("a cycle and a plain-string cause still end the walk safely", () => {
    const a = new BaseError("link-a")
    const b = new BaseError("link-b", { cause: a })
    a.cause = b
    assert.equal(typeof collectErrorText(b), "string")
    assert.equal(collectErrorText("Plain STRING"), "plain string")
    assert.equal(collectErrorText(null), "")
  })
})
