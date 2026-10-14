# Feedback — fix/codeql-sanitizer-proof

- [x] C1 local harness + baseline  - [x] C2 forLog recognised  - [x] suite/lint/tsc/diff/link

## 1. CLI + commands
gh-codeql `cb1d8f37`, CodeQL CLI **v2.27.2** (`gh codeql set-version latest` resolved to it; pinned with `set-version v2.27.2`
because `latest` re-downloaded 936 MB on every call). Query sources read at tag `codeql-cli/v2.27.2`.
`scripts/codeql-local.sh` = `pack download codeql/javascript-queries` (CLI does not bundle it) + `database create --language=javascript-typescript`
+ `database analyze …/CWE-117/LogInjection.ql --format=sarif-latest`, then a file:line summary. Output only in `/tmp/ts-codeql`.

## 2. Baseline (origin/main 049cc8e): 22 results
log-swap/route 129 · validate-execution/route 155,158 · **swap/route 243** · alert-wrapper 269,288,299,324,333 · chainlink 538 ·
kv-rate-limiter 131,135 · rpc-chain-identity 269,273 · source-state-machine 85,89,93,195,218,246,252 · utils 43.

## 3. Sanitizer matched
```
class StringReplaceSanitizer extends Sanitizer {
  exists(string s | this.(StringReplaceCall).replaces(s, "") and s.regexpMatch("\\n"))
```
The replacement MUST be `""`. `forLog` used `' '` (its comment claimed otherwise) so the barrier never matched. Interprocedural
tracking is fine: the barrier is the replace-call node inside the helper. The task's example shape (`' '`) would NOT work.
Final: `String(v).replace(/[\r\n]/g, '').replace(/[\x00-\x1f\x7f]/g, '')` then slice; C0 stripping kept, recognition unaffected.
Code route; no model extension needed. Behaviour change: CR/LF are now removed, not spaced.

## 4. After fix: 4 results (22 -> 5 -> 4)
Step 1 (shape only): 22 -> 5. Cleared: swap/route:243, log-swap, alert-wrapper, kv-rate-limiter, source-state-machine, rpc-chain-identity:269.
Step 2 (one call site): `rpc-chain-identity.ts:273` still flagged. SARIF path: `body.chain` (validate-execution:139) -> chainId ->
expectedChainId -> unwrapped `${expectedChainId}`. Not a recognition issue, but Done needs 0 on this file, so the one token became
`${forLog(expectedChainId)}` (the ONLY call-site change; shape did not require it, the Done criterion did). Result: 0 in rpc-chain-identity.
Remaining 4: validate-execution/route 155,158 · chainlink 538 · utils 43 — none import forLog; sinks are raw `console.*` template
strings fed by the same request body. Whether they belong to the #566 set is UNVERIFIED (I did not read #566); if they do, they need
forLog at the call site, which this brief said to leave alone -> owner call.
Out-of-list reads (unrecorded when done, flagged by the stop hook; NOT owner-accepted): single lines of validate-execution:155,
chainlink:538, utils:43, and SARIF path locations. Recorded here now.

## 5. Verify
tsc clean · eslint 92 warnings = origin/main 92 (delta 0) · vitest 4419 tests, all pass after one expectation edit.
Deviations vs allowed diff: `.gitignore` +2 (un-ignore the script, grok precedent); `src/lib/rpc-chain-identity.ts` L273 (1 token, above); `src/app/api/swap/route.test.ts` — one test pinned the old
`'  '` spacing, updated to the new no-space output (no call-site code changed).
Final CodeQL run is on the committed code.
