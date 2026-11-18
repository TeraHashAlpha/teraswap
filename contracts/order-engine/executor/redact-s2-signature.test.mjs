// [fix/keeper-errors-no-signature] A87 S-2 (audit of PR #709; pre-existing on origin/main 7bd3ec12).
//
// redactError printed viem's err.message. For the two order calls that message carries the order's EIP-712
// signature twice: in the Contract Call block (`args:`) and inside the hex of `Request body:` / `Raw Call
// Arguments` (`data:`). That text reached:
//   - the keeper log line            executor.js:2156  console.error(`Order …… error:`, redactError(err))
//   - stats.lastError.message        executor.js:2161  → monitor.js:70 "Last error:" (onCycleEnd)
//   - the Telegram alert             executor.js:2644  monitor.onCycleError(err) → monitor.js:126
// and the write site's text ran past 4,096 characters, which Telegram refuses: the alert was lost.
//
// Step 0 builds the REAL viem 2.47.10 errors (viem-wrapped-errors.fixture.mjs: viem's own clients against a local
// JSON-RPC stub, no network) for the keeper's three call sites x revert / RPC error / timeout, around a DUMMY 65-byte
// signature and 1 KB of router calldata. On origin/main all nine cases leak the signature and the write-site alerts
// exceed 4,096 characters.
//
// Run: node --test contracts/order-engine/executor/redact-s2-signature.test.mjs

import { test, describe, before, after, mock } from "node:test"
import assert from "node:assert/strict"

process.env.TELEGRAM_BOT_TOKEN = "TESTBOTTOKEN"
process.env.TELEGRAM_CHAT_ID = "1"
process.env.CHAIN_ID = "8453"

const { redactError } = await import("./redact.js")
const { ExecutorMonitor } = await import("./monitor.js")
const { startRpcStub, revertStringData } = await import("./viem-wrapped-errors.fixture.mjs")

// A DUMMY 65-byte signature (never a real one): 130 hex digits in a pattern nothing else in a viem text produces.
const SIG_HEX = `${"dead5ea1".repeat(16)}1b`
const SIGNATURE = `0x${SIG_HEX}`
// 1 KB of router calldata, a realistic swap payload (the audit measured alert texts of 1,261 to 5,038 characters).
const ROUTER_DATA = `0x${"ab".repeat(1024)}`
const TELEGRAM_MAX = 4096
const HEX_RUN_130 = /[0-9a-f]{130,}/i

const MODES = {
  revert: { rpc: { code: 3, message: "execution reverted: not ready", data: revertStringData("not ready") } },
  "rpc error": { rpc: { code: -32603, message: "internal error" } },
  timeout: { hang: true },
}
const SITES = {
  "read canExecute": (stub, spec) => stub.readError(spec, { signature: SIGNATURE }),
  "write executeOrder @ eth_estimateGas": (stub, spec) => stub.writeError(spec, { signature: SIGNATURE, routerData: ROUTER_DATA }),
  "write executeOrder @ eth_sendRawTransaction": (stub, spec) =>
    stub.writeError(spec, { failAt: "eth_sendRawTransaction", signature: SIGNATURE, routerData: ROUTER_DATA }),
}

const cases = []
let stub
before(async () => {
  stub = await startRpcStub()
  for (const [site, build] of Object.entries(SITES)) {
    for (const [mode, spec] of Object.entries(MODES)) cases.push({ site, mode, err: await build(stub, spec) })
  }
})
after(async () => {
  await stub.stop()
})

/** The one Telegram text a monitor sends for `trigger(monitor)`; fetch is stubbed, nothing leaves the process. */
async function alertText(trigger) {
  const sent = []
  const fetchMock = mock.method(globalThis, "fetch", async (_url, init) => {
    sent.push(JSON.parse(init.body).text)
    return { ok: true }
  })
  try {
    const stats = { startedAt: new Date().toISOString(), lastError: null }
    trigger(new ExecutorMonitor(stats), stats)
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    fetchMock.mock.restore()
  }
  assert.equal(sent.length, 1, "exactly one alert is sent (never dropped)")
  return sent[0]
}

const leaks = (text) => text.toLowerCase().includes(SIG_HEX) || HEX_RUN_130.test(text)

describe("Step 0 [A87 S-2]: the fixtures are the real thing", () => {
  test("nine real viem errors, each carrying the dummy signature in err.message", () => {
    assert.equal(cases.length, 9)
    for (const { site, mode, err } of cases) {
      assert.ok(err.message.toLowerCase().includes(SIG_HEX), `${site} / ${mode}: fixture sanity`)
      assert.equal(err.name, "ContractFunctionExecutionError", `${site} / ${mode}`)
    }
  })
})

describe("Step 0 [A87 S-2]: no signature in the keeper log line (executor.js:2156)", () => {
  for (const site of Object.keys(SITES)) {
    for (const mode of Object.keys(MODES)) {
      test(`${site} / ${mode}`, () => {
        const { err } = cases.find((c) => c.site === site && c.mode === mode)
        const line = redactError(err)
        assert.ok(!leaks(line), `signature or a 130+ hex run in: ${line.slice(0, 300)}…`)
      })
    }
  }
})

describe("Step 0 [A87 S-2]: the Telegram alert carries no signature and stays under 4,096 characters", () => {
  for (const site of Object.keys(SITES)) {
    for (const mode of Object.keys(MODES)) {
      test(`${site} / ${mode}: onCycleError (executor.js:2644 → monitor.js:126)`, async () => {
        const { err } = cases.find((c) => c.site === site && c.mode === mode)
        const text = await alertText((m) => {
          for (let i = 0; i < 3; i++) m.onCycleError(err)
        })
        assert.ok(!leaks(text), `signature in the alert: ${text.slice(0, 300)}…`)
        assert.ok(text.length <= TELEGRAM_MAX, `alert text is ${text.length} characters`)
      })
      test(`${site} / ${mode}: onCycleEnd with stats.lastError (executor.js:2161 → monitor.js:70)`, async () => {
        const { err } = cases.find((c) => c.site === site && c.mode === mode)
        const text = await alertText((m, stats) => {
          stats.lastError = { orderId: "0b3c9e1a-0000-4000-8000-000000000000", message: redactError(err), at: new Date().toISOString() }
          m.onCycleEnd(0, 3)
        })
        assert.ok(!leaks(text), `signature in the alert: ${text.slice(0, 300)}…`)
        assert.ok(text.length <= TELEGRAM_MAX, `alert text is ${text.length} characters`)
      })
    }
  }

  // Measured on origin/main (FEEDBACK tables): the timeouts are the long ones (viem adds the Request body and the Raw
  // Call Arguments); at this site the alert text was 14,907 characters.
  test("the longest raw text (write @ eth_estimateGas, timeout) is over 4,096, yet its alert is sent under it", async () => {
    const { err } = cases.find((c) => c.site === "write executeOrder @ eth_estimateGas" && c.mode === "timeout")
    assert.ok(err.message.length > TELEGRAM_MAX, `fixture sanity: raw message is ${err.message.length} characters`)
    const text = await alertText((m) => {
      for (let i = 0; i < 3; i++) m.onCycleError(err)
    })
    assert.ok(text.length <= TELEGRAM_MAX, `alert text is ${text.length} characters`)
  })
})
