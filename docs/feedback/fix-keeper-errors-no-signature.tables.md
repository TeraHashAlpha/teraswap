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

## R2. Round 2 — A92 audit of PR #717 (findings S-1..S-8)

All runs on head 0e411f1f (the verified commit) unless named; Node 22.23.5 and 20.20.2 from /opt/homebrew/opt/node@22, node@20.

### R2-1. S-1: the operator CLIs and a keyed RPC URL (redact-a92-s1-cli.test.mjs)

Each case spawns the real CLI against a local JSON-RPC stub reached through `http://127.0.0.1:<port>/v2/<marker>`
(RPC_URL and BACKFILL_RPC_URL), with `--import short-viem-timeout.fixture.mjs` (owner answer 3: only viem's own
10,000 ms request timer becomes 200 ms; the socket really hangs). Assertion: no stdout or stderr line holds the marker.

| CLI / provider | path reached | merge 68769f0c (before) | head |
|---|---|---|---|
| list-missing-fills, 503 on every call | getBlockNumber → :329 FATAL | FAIL: stderr `URL: http://127.0.0.1:…/v2/<marker>` | pass |
| list-missing-fills, hang on every call | same, viem TimeoutError | FAIL: stderr `URL:` line | pass |
| list-missing-fills, 503 on eth_getLogs only | verified binding → :114 retry line → :291 | FAIL: stdout retry line `URL:` | pass |
| list-missing-fills, hang on eth_getLogs only | same, TimeoutError | FAIL: stdout retry line | pass |
| backfill-execution, 503 on every call | :158 banner → getTransactionReceipt → :306 | FAIL: stdout banner `via RPC http://…/v2/<marker>` | pass |
| backfill-execution, hang on every call | same, TimeoutError | FAIL: stdout banner | pass |

What the operator reads now (503 on eth_getLogs): `[list-missing-fills] range error on 0-16 (HttpRequestError: HTTP
request failed.⏎Status: 503⏎URL: http://127.0.0.1:<port>/REDACTED⏎Details: "Service Unavailable"), retrying …`, then the
same text on stderr and `Refusing to scan against <provider>.`; backfill: `=== Backfill 0xabab… (apply=false) via RPC
host=127.0.0.1:<port> ===` and `FATAL: HttpRequestError: HTTP request failed.⏎Status: 503⏎URL: …/REDACTED⏎Details: …`.
The audit's own p2-cli.mjs (HTTP 500 to everything, its own key): 0 printed lines carry the key, both CLIs.

### R2-2. S-3: three monitor alerts before and after (dummy signature `0x` + `dead5ea1`×16 + `1b`, 1 KB router data)

Captured with the real monitor.js / alert.js (fetch stubbed for api.telegram.org only); envelope lines (title, Host,
Time, Chain) omitted, port masked. Before = round 1's head 788dcaa3; after = 0e411f1f. No text holds the signature.

- read canExecute / revert, onCycleEnd (monitor.js:70), 296 → 390 chars
  - before: `Last error: ContractFunctionExecutionError: The contract function "canExecute" reverted with the following reason: not ready⏎Details: execution reverted: not ready`
  - after: `Last error (order 0b3c9e1a…): ContractFunctionExecutionError: The contract function "canExecute" reverted with the following reason: not ready⏎address:   0x000000000000000000000000000000000000beef⏎function:  canExecute⏎Details: execution reverted: not ready`
- write executeOrder @ eth_estimateGas / timeout, onCycleError (monitor.js:126), 275 → 353 chars
  - before: `Last error: ContractFunctionExecutionError: The request took too long to respond.⏎URL: http://127.0.0.1:<port>/⏎Details: The request timed out.`
  - after: `Last error: ContractFunctionExecutionError: The request took too long to respond.⏎URL: http://127.0.0.1:<port>/⏎address:   0x000000000000000000000000000000000000beef⏎function:  executeOrder⏎Details: The request timed out.`
- write executeOrder @ eth_sendRawTransaction / RPC error -32603, onCycleError (monitor.js:126), 288 → 366 chars
  - before: `Last error: ContractFunctionExecutionError: The contract function "executeOrder" reverted with the following reason: internal error⏎Details: internal error`
  - after: `Last error: ContractFunctionExecutionError: The contract function "executeOrder" reverted with the following reason: internal error⏎address:   0x000000000000000000000000000000000000beef⏎function:  executeOrder⏎Details: internal error`

onCycleError gets the error itself and has no order id (executor.js:2644 passes `err` only), so only onCycleEnd names
the order. S-2 at boot (redact-a92-s2-boot-reason.test.mjs, real executor.js, ORDER_TYPEHASH() reverting):
`ChainVerificationError: FATAL: could not read ORDER_TYPEHASH() from ORDER_EXECUTOR_V3_ADDRESS (v3) 0x…0a92 on chain
42161 after 3 attempt(s): The contract function "ORDER_TYPEHASH" reverted with the following reason: A92 typehash gate
says no — the address may not be a TeraSwapOrderExecutor at all. Refusing to boot.` and, at the instance gate,
`ChainVerificationError: FATAL: could not read whitelistedExecutors(0x19E7…Aff2A) from ORDER_EXECUTOR_V3_ADDRESS (v3)
0x…0a92 on chain 42161 after 3 attempt(s): The contract function "whitelistedExecutors" reverted with the following
reason: A92 whitelist read says no — refusing to boot` (each one line, captured from the test's boots; the audit
measured the line ending at `reason:` before).

### R2-3. S-5 differential, mutation proof, the audit's probes

- **Differential** (scratchpad p-s5-diff.mjs): main = a scratch extraction (`git archive origin/main`, 85a6f9cb; its
  executor dir is byte-identical to 7bd3ec12) with this worktree's node_modules (same package-lock). Seeds 1..20,000,
  one error shape each: names, statuses, messages / shortMessage / details / reason / metaMessages, revert data, cause
  chains to depth 3; fragments are provider auth words, revert words, hex runs of 0-400 digits with or without `0x`,
  keyed URLs (path, userinfo, percent-encoded, schemeless), glued or separated. 12,578 shapes hold a `0x` run of 130+
  hex glued to `unauthori[sz]ed`; main classifies 8,216 auth / 11,784 transient.
  `classifyRpcError` and `classifyMissCause({ err })`: head vs main **0 of 20,000 differ**; round 1 (788dcaa3) vs main
  219 differ (the S-5 shape: transient → auth, `rpc-transport`/`unclassified` → `rpc-auth`), so the generator sees the
  defect. The audit's p2-classify.mjs, head vs main: 0 of 20,129 differ (33 real viem errors). The committed test
  pins five shapes with the answers measured on main.
- **Mutation** (scratchpad mutants.mjs: fresh copy of the executor dir, node_modules symlinked, exact replacement,
  then the five round-2 test files + redact-s2-error-text.test.mjs on Node 22). Baseline: 0 failing.

| Mutant | failing tests | killed by |
|---|---|---|
| M1a list-missing-fills :329 prints raw err.message | 2 | redact-a92-s1-cli 4/6 |
| M1b list-missing-fills :291 prints raw err.message | 2 | redact-a92-s1-cli 4/6 |
| M1c list-missing-fills :114 prints raw err.message | 2 | redact-a92-s1-cli 4/6 |
| M1d backfill-execution :306 prints raw err.message | 2 | redact-a92-s1-cli 4/6 |
| M1e backfill-execution :158 prints the whole RPC URL | 2 | redact-a92-s1-cli 4/6 |
| M2 chain-verify errText newline flatten removed | 3 | redact-a92-s2-boot-reason 0/3 |
| M3 redactError drops the `address:` line | 13 | redact-a92-s3-contract-call 4/13; redact-s2-error-text 21/25 |
| M4 extractRevertData depth cap removed | 3 | redact-a92-s4-cause-depth 2/5 |
| M5 rpc-auth given the hex scrub again (redactUrl) | 3 | rpc-auth-a92-s5-url-only 4/7 |
| M6 `function:` line not cut at the parenthesis (extra) | 13 | redact-a92-s3-contract-call 4/13; redact-s2-error-text 21/25 |
| M7 monitor alert without the order id (extra) | 11 | redact-a92-s3-contract-call 2/13 |

- **The audit's signature probe** (its own p1-viem.mjs + rpc-stub.mjs, unmodified, run against this worktree): 75
  real viem errors (canExecute / executeOrder at eth_estimateGas and eth_sendRawTransaction; revert, custom error,
  SwapFailed, RPC errors, HTTP 500 / 403, timeout, nonce, funds, receipt timeout; lower- and upper-case signature),
  7 sinks each (log line, lastError, both monitor alerts, alertOps, raw alertOps, fatal): **0 errors with a fragment
  in any sink, 0 over a cap**, Node 22 and Node 20. p3-infinite-cause.mjs: extractRevertData and redactError return in
  0 ms on both Nodes (the audit measured exit 134, heap exhausted, on round 1).
- Keeper suite: Node 22.23.5 2,201/2,201, Node 20.20.2 2,201/2,201, 0 cancelled (round 1: 2,167). gitleaks 8.30.1 over
  the 5 round-2 commits (68769f0c..0e411f1f): no leaks.
