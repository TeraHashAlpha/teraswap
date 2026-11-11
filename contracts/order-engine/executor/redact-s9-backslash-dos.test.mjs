// [A74 S-9 (M)] The escape decoders used `\\+` ("one or more backslashes") in front of a literal. On a
// run of N backslashes that is not followed by that literal, every start position scans the rest of the run
// and backtracks: O(N²). 80 000 backslashes blocked the event loop for ~16 s — one hostile error body in an
// alert path stalls the keeper. The decoders now accept `\\{1,8}`, and a run longer than 8 is first clamped
// to 8 in one linear pass, so a long run is still decoded (never a way to hide a delimiter) and never costly.
//
// Fixture key only (TESTKEY); no network.
//
// Run: node --test contracts/order-engine/executor/redact-s9-backslash-dos.test.mjs

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { redactUrl, redactError } from "./redact.js"

const KEY = "TESTKEY"
const HOST = "base-mainnet.g.alchemy.com"
const CLEAN = `https://${HOST}/REDACTED`
const bs = (n) => "\\".repeat(n)
const N = 80_000
const LIMIT_MS = 1_000

function timed(label, input) {
  test(`${label} (< ${LIMIT_MS} ms)`, () => {
    const t = process.hrtime.bigint()
    redactUrl(input)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    assert.ok(ms < LIMIT_MS, `${label}: ${ms.toFixed(0)} ms`)
  })
}

describe("[A74 S-9] a long backslash run does not block the loop", () => {
  timed("80k backslashes", bs(N))
  timed("80k backslashes then a letter", bs(N) + "q")
  timed("80k backslashes then `u00`", bs(N) + "u00")
  timed("80k backslashes then `x`", bs(N) + "x")
  timed("80k backslashes then two octal digits", bs(N) + "05")
  timed("80k backslashes then `u{`", bs(N) + "u{")
  timed("80k `\\/` pairs", "\\/".repeat(N))
  timed("80k `\\\\u00` blocks", "\\u00".repeat(N))
  timed("a run inside a URL", `https://${HOST}/v2/${bs(N)}q/${KEY}`)
  test("redactError on such a body", () => {
    const t = process.hrtime.bigint()
    redactError(new Error(`HTTP request failed. Details: ${bs(N)}q`))
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < LIMIT_MS)
  })
})

describe("[A74 S-9] a long run is still decoded, never a hiding place for a delimiter", () => {
  for (const n of [1, 2, 8, 9, 16, 100, 5_000]) {
    test(`${n} backslashes in front of every slash, \\u002f, \\x2f and \\057`, () => {
      const slash = (form) => `${bs(n)}${form}`
      const rows = [
        `https:${slash("/")}${slash("/")}${HOST}${slash("/")}v2${slash("/")}${KEY}`,
        `https:${slash("u002f")}${slash("u002f")}${HOST}${slash("u002f")}v2${slash("u002f")}${KEY}`,
        `https:${slash("x2f")}${slash("x2f")}${HOST}${slash("x2f")}v2${slash("x2f")}${KEY}`,
        `https:${slash("057")}${slash("057")}${HOST}${slash("057")}v2${slash("057")}${KEY}`,
        `https://${HOST}${slash("u003f")}apikey=${KEY}`,
        `https://user:${KEY}${slash("u0040")}${HOST}/v2/x`,
      ]
      for (const input of rows) {
        const out = redactUrl(input)
        assert.ok(!out.includes(KEY), out)
        assert.equal(out, CLEAN)
      }
    })
  }

  test("short runs of backslashes elsewhere are left as they are", () => {
    for (const s of ["C:\\Users\\keeper\\executor.js", "line1\\nline2", "a\\\\b", "regex \\d+\\s*"]) {
      assert.equal(redactUrl(s), s)
    }
  })
})

describe("[A74 S-9] the source carries the bound", () => {
  const src = readFileSync(new URL("./redact.js", import.meta.url), "utf-8")
  test("no unbounded `\\\\+` quantifier remains in a decoder pattern", () => {
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n")
    assert.ok(!/\\\\\+/.test(code), "an unbounded backslash run (\\\\+) is back in redact.js")
    assert.ok(/\\\\\{1,8\}/.test(code), "the bounded \\\\{1,8} run is missing")
  })
})
