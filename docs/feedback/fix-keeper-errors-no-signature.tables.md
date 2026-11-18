# fix/keeper-errors-no-signature — evidence tables

Companion of `fix-keeper-errors-no-signature.md`. Lines are at this branch's head; executor.js is unchanged from
origin/main 7bd3ec12, so its lines are the same on both.

## 1. Every place error text reaches a log line or an alert

Found with `grep` for `redactError(`/`redactUrl(`/`.message`/`String(e…)`/`console.*(…err…)` and a scan of every
`catch (x)` block in the keeper's non-test sources (lines that use `x`), plus every `.catch(` / `on("error")` handler.

### Keeper, through `redactError` (now: short text, scrub, 600 cap; every caller gets it)

| file:line | sink | carries the order signature on main? |
|---|---|---|
| executor.js:2156 | `console.error("Order …… error:", redactError(err))` (canExecute / executeOrder) | **yes, 9/9 cases** |
| executor.js:2161 | `stats.lastError.message` → monitor.js:70 Telegram "Last error:" | **yes, 9/9** |
| executor.js:2644 | `monitor.onCycleError(err)` → monitor.js:126 Telegram "Last error:" | **yes** (if a per-order error reaches the cycle catch) |
| executor.js:948, 983, 1252, 1611 | `log(… redactError(err[, {max}]) …)` freeze / ETH-USD / balance / Chainlink reads | no (reads without the signature) |
| executor.js:1256 | `alertOps({kind:"rpc", detail: … redactError(err)})` → Telegram | no |
| executor.js:1063 | `console.error("fetchSwapRoute error:", redactError(err))` | no |
| executor.js:2105 | `rec.error` ← record-execution.js:203 `redactError(err)` | no |
| executor.js:2444, 2477 | boot refusal `console.error(redactError(err))` (ChainVerificationError) | no (see limit L-1) |
| executor.js:2561 | `log(… redactError(err, {max:120}))` runtime-config publish | no |
| executor.js:2639 | `console.error("Cycle error:", redactError(err))` | possible (any cycle error) |
| monitor.js:237, 245 | `console.warn(… redactError(err))` metrics server | no |
| alert.js:112 | `console.error("[ALERT] Telegram send failed:", redactError(err))` | no |
| event-watcher.js:317, 326 | poll error log line and "Event Watcher Degraded" Telegram | no |
| env.js:50 | `console.warn(… redactError(err))` .env load | no |
| runtime-config.js:103, 181 | `redactError(err, {max:160})` → log | no |

### Keeper, through `redactUrl` only (now also `0x<hex N>` for a `0x` run of 130+, owner answer 3)

| file:line | sink |
|---|---|
| executor.js:2665 | `console.error("Fatal error:", redactUrl(err?.stack \|\| redactError(err)))`: a viem stack repeats the whole message (args, signature) |
| alert.js:80-95 | `sendTelegramAlert` final pass over EVERY keeper alert, then `capAlertText(…, 4000)` |
| alert.js:357 | `alertOps` `Detail:` |
| executor.js:2508 | Flashbots RPC URL (config, not an error) |
| rpc-auth.js:122 | classification text only; logs/alerts carry the label table's `signal` (rpc-auth.js:127-146) |

### Keeper, own redactor or labels only (unchanged)

| file:line | what reaches the log |
|---|---|
| chain-verify.js:236 `errText` (sites 384, 419, 459, 568) | `redactUrls` (stricter: whole URL → `<redacted-url>`, 32+ hex → `<redacted-secret>`) |
| retry-policy.js:113 | classification text only; logs and alerts carry `cause` / `causeReason` labels (executor.js:858, 886, 901) |
| basket-coordinator.js:215 `errorName` (272, 470, 496, 547, 607, 656, 832) | the error's name only (file off-limits) |

### Keeper, raw (not through any redactor; unchanged)

| file:line | what | why unchanged |
|---|---|---|
| executor.js:2147 | `SwapFailed → … inner=${sf.innerHex}`: the router's revert bytes | not the order signature; executor.js off-limits. Its Telegram copy (pinned-route-revert detail) now shows `0x<hex N>` for 130+ |
| backfill-execution.mjs:297; list-missing-fills.mjs:110, 287, 325 | `err.message` to the operator's terminal (manual CLIs) | only `eth_getLogs`/block reads, no signature-bearing call; a keyed RPC URL could print there (pre-existing, outside S-2) |

### App (`src/lib/alert-channels`, owner answer 2: one shared `scrubAlertText`, utils.ts:69)

| file:line | sink | before → now |
|---|---|---|
| telegram.ts:143 | reason → outgoing `text` | escapeHtml only → scrubAlertText + escapeHtml |
| telegram.ts:77, 83 (scrubToken, :50) | thrown delivery error | bot token by value → shared scrub (all channel secrets, URLs, hex, cap) |
| email.ts:32 | reason → outgoing `html` | escapeHtml only → scrubAlertText + escapeHtml |
| email.ts:84, 89 | thrown error (fetch failure, non-OK body) | raw provider body → shared scrub |
| discord.ts:75 | reason → embed field | raw → scrubAlertText (cap 1,000 < Discord's 1,024) |
| discord.ts:85, 90 | thrown error | raw provider body → shared scrub |
| alert-wrapper.ts:225, 288, 324; api/monitor/alerts/route.ts:77 | log the channel's `err.message` | now already scrubbed at the source |
| alert-wrapper.ts:70, 106, 178, 186 | KV client errors (not a channel) | unchanged |
| api/telegram/webhook/route.ts:170, 188, 211 | the bot webhook's own Telegram calls (not an alert channel) | unchanged |

## 2. Step 0 (redact-s2-signature.test.mjs, 29 tests), before and after

origin/main code (bb7b8403 = origin/main + the test only): 28 of 29 FAIL (9/9 log lines and 18/18 alert paths
carry the dummy signature; the longest alert is 14,907 characters). Branch head: 29 of 29 pass (Node 20 and 22).

Per case, measured (`raw` = viem's err.message; `line` = redactError; `alert` = the Telegram text, onCycleError path):

| site | mode | raw | line before → after | alert before → after | signature before → after |
|---|---|---:|---:|---:|---|
| read canExecute | revert | 1,302 | 1,284 → 151 | 1,429 → 296 | yes → no |
| read canExecute | RPC error | 1,292 | 1,274 → 141 | 1,419 → 286 | yes → no |
| read canExecute | timeout | 4,193 | 4,175 → 130 | **4,320** → 275 | yes → no |
| write @ eth_estimateGas | revert | 3,435 | 3,416 → 153 | 3,561 → 298 | yes → no |
| write @ eth_estimateGas | RPC error | 3,425 | 3,406 → 143 | 3,551 → 288 | yes → no |
| write @ eth_estimateGas | timeout | 14,781 | 14,762 → 130 | **14,907** → 275 | yes → no |
| write @ eth_sendRawTransaction | revert | 3,435 | 3,416 → 153 | 3,561 → 298 | yes → no |
| write @ eth_sendRawTransaction | RPC error | 3,425 | 3,406 → 143 | 3,551 → 288 | yes → no |
| write @ eth_sendRawTransaction | timeout | 11,015 | 10,996 → 130 | **11,141** → 275 | yes → no |

(1 KB of router calldata; bold = over Telegram's 4,096, refused and lost on main.)

## 3. Alert samples (onCycleError path; host masked, signature hex shown as `<SIG>`; Time and blank lines omitted)

Before, read canExecute / revert (1,429 characters; first lines):

```
🚨 <b>TeraSwap Executor Alert</b>
Host: <host>
Chain: 8453
⚠️ 3 consecutive errors!
Last error: The contract function "canExecute" reverted with the following reason:
not ready
Contract Call:
  address:   0x000000000000000000000000000000000000beef
  function:  canExecute((address owner, … uint256 dcaTotal), bytes signature)
  args:                ({"owner":"0x…a1", …}, 0x<SIG>)
```

After, the same error (296 characters):

```
🚨 <b>TeraSwap Executor Alert</b>
Host: <host>
Chain: 8453
⚠️ 3 consecutive errors!
Last error: ContractFunctionExecutionError: The contract function "canExecute" reverted with the following reason: not ready
Details: execution reverted: not ready
```

Before, write executeOrder @ eth_estimateGas / timeout: 14,907 characters (`Request body:` with the full calldata, `Raw Call
Arguments`, `Contract Call … args:` with `<SIG>` and 1 KB of router data); Telegram refuses it. After (275 characters):

```
Last error: ContractFunctionExecutionError: The request took too long to respond.
URL: http://127.0.0.1:<port>/
Details: The request timed out.
```

## 4. Seeds and mutation proof

Property test (redact-s2-property.test.mjs): default seeds 1..24 × 40 cases, about 1 s (user CPU 0.7 s). Wider run
`S2_SEEDS=1-500`: 1,000/1,000 tests, 20,000 redactError cases (6,660 real viem ContractFunctionExecutionError, 590
multi-megabyte inputs up to 3.0 MB, 3,406 hostile objects) and 20,000 capAlertText cases, 10 s.

Mutants on a scratch copy of the executor directory, each run against redact*.test.mjs, chainlink-debug-read and
alert tests (375 tests):

| mutant | failing | killed by (examples) |
|---|---:|---|
| M1 hex scrub removed (redactError and redactUrl) | 31 | the scrub unit test, multi-MB test, property seeds 1, 2, … |
| M2 cap removed | 19 | "at most 600 characters", caller `max`, multi-MB, property seeds |
| M3 shortMessage ignored | 3 | the revert unit test, "shortMessage wins", existing redact.test.mjs "truncates AFTER redacting…" |
| M4 args/data/Arguments block scrub removed (extra) | 25 | the block unit test, property seeds 1-4, … |
| M5 alert cap removed (extra) | 29 | capAlertText units, monitor and sendTelegramAlert caps |
| M6 revert reason ignored (extra) | 2 | custom-error and SwapFailed reason tests |

App: scrub.test.ts with origin/main's telegram.ts / email.ts / discord.ts (new utils.ts kept): 10 of 19 FAIL (all three
outgoing bodies, the Discord field length, the 400-body and transport-error paths of all three); branch: 19/19.

## 5. Known limits (measured, not changed)

- **L-1 (boot refusal, Low).** chain-verify's `errText` embeds viem's `shortMessage`, which is two lines for a revert
  (`…reverted with the following reason:\n<reason>`). Under the first-line rule (owner answer 1) the boot log line
  (executor.js:2444/2477) keeps `ChainVerificationError: … reverted with the following reason:` and loses
  `<reason> — refusing to boot`. Measured with a ChainVerificationError built as chain-verify builds it. No signature
  is involved (boot reads carry none). One-line fix for the owner to choose: flatten newlines in chain-verify.js
  `errText`, or take the message's first paragraph instead of its first line.
- A plain `Error` keeps no `Error:` prefix: chainlink-debug-read.test.mjs:105 pins that line without one.
- The 130-hex threshold is the goal's: a fragment shorter than 130 hex digits is not scrubbed.
