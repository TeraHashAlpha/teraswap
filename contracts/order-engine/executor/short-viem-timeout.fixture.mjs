// short-viem-timeout.fixture.mjs — TEST-ONLY preload (not a test: node --test does not pick it up).
//
// [A92 S-1, owner answer 3] A child process started with `node --import <this file> <cli>` sees viem's http transport
// time out after SHORT_MS instead of 10 s. viem waits 10,000 ms per attempt (http.js `timeout ?? 10_000`) and makes 4
// attempts, so one hung call costs about 41 s; the operator-CLI test makes several. ONLY a 10,000 ms timer armed from
// viem's own code (utils/promise/withTimeout.js, by its stack) is shortened: chain-verify's own 10,000 ms timeout and
// every other timer keep their delay. The provider socket still really hangs, and the error the CLI prints is viem's
// real TimeoutError.

const SHORT_MS = 200
const VIEM_TIMEOUT_MS = 10_000
const VIEM_FRAME = /[\\/]node_modules[\\/]viem[\\/]/

const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = function setTimeout(fn, ms, ...rest) {
  const fromViem = ms === VIEM_TIMEOUT_MS && VIEM_FRAME.test(new Error().stack ?? "")
  return realSetTimeout(fn, fromViem ? SHORT_MS : ms, ...rest)
}
