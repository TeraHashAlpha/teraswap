# Feedback — fix/codeql-log-injection
Log calls only; no control-flow/return/throw/KV-key/rate-limit change. No dismissals, no PR.

- [x] 1 sanitiser + test; rpc-chain-identity reconciled  - [x] 2 applied at log calls  - [x] 3 #12 evidence
- [x] 4 verify  - [x] 5 push + compare  - [x] 6 validate-execution/route.ts:157 suppression replaced (owner accepted read + comment-only edit in-session)

**1 Sanitiser** `src/lib/log-sanitize.ts` `forLog(value,max=200)`; tests in `log-sanitize.test.ts`: CR/LF replaced · tab/ESC/C0/DEL stripped · truncation · non-string input · clean text untouched.
rpc-chain-identity's private `forLog` removed; sinks use `forLog(sanitizeUpstreamError(x), Infinity)` (redaction kept; no truncation, msg >200 chars is test-pinned).

**2 Per alert** (before → after)
- #8 source-state-machine:195 template w/ `${id}` → const `%s` format + `forLog(id)`
- #9 :252 template w/ `${status.id}` → const `%s` format + `forLog(status.id)`
- #22 :85, #23 :89, #24 :93 `${sourceId}` → `${forLog(sourceId)}`
- #25 :195 / #28 :252 → fixed with #8 / #9 (same lines)
- #26 :218 `${sourceId}: ${message}` → both via `forLog`
- #27 :246 `${status.id}…(${reason})` → both via `forLog`
- #15 log-swap/route.ts:129 `${tokenInSymbol} (${tokenIn})` → both via `forLog`
- #39 kv-rate-limiter:131, #40 :135 `${key}` → `${forLog(key)}` (key/redisKey untouched)
- #17 alert-wrapper:269 `${category}` → `forLog(category)`
- #18 :288, #20 :324 `${sourceId}: ${err msg}` → both via `forLog`
- #19 :299, #21 :333 `${sourceId}` → `forLog(sourceId)`
- #57 rpc-chain-identity:269, #58 :273 local forLog → shared `forLog(sanitizeUpstreamError(..), Infinity)`
- #4 monitoring-loop.test.ts:~403 `.includes('api.telegram.org')` → `new URL(..).hostname ===` (try/catch)
- #59 grok-dispatch.test.mjs:322 `execFileSync('cat')` → `readFileSync`
- #14 capture-endpoint-baseline.ts:240 → unconditional `mkdirSync(dir,{recursive:true})`. PARTIAL: `existsSync(outputPath)` at :209 remains (guards reading an existing baseline; removing it changes control flow) — alert may stay open.
- Skipped: #11 (rejectUnauthorized:false is the purpose; dismissal; comment :53 replaced) · #42, #54 (fixed-path write / manual RPC script; no 1–2 line fix; dismissal)
- Suppressions `// codeql[...]`: replaced 3 (monitoring-loop.test.ts, capture-endpoint-baseline.ts:53, validate-execution/route.ts:157). validate-execution/route.ts:157 replaced (3rd; owner-accepted). Untouched: api-auth.ts:93 + swap/route.ts:253 (OUT), fingerprint-validator.ts:318 (read-only).

**3 KV unchanged** `kv-rate-limiter.test.ts` "[CodeQL log-injection] only the LOG line is sanitised": "KV path: Redis key stays byte-identical" · "fallback path: map key is the raw key and ceil(limit/2) math is unchanged" · "fallback log lines carry no CR/LF/ESC".

**4 #12** fingerprint-validator.ts: `tls.connect(..,{rejectUnauthorized:false})` :319; callback only calls `getPeerCertificate(true)` :321 and reads fingerprint256/subjectaltname/issuer.CN/subject.CN :322–335. No `data` listener, no `.write`, no HTTP; socket destroyed :338/:340/:341. No response body exists. (Callers of `captureLiveTLS` not inspected.)

**5 Verify** vitest main e4b2def 4401 → branch 4409 (+8) · tsc 0 errors · eslint 94 = baseline · diff --stat 12 files +146/−48 (+ this file). CodeQL recognition of `forLog` unverified until PR CI.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/codeql-log-injection

**Owner answers (in-session, supersede goal text):** read of validate-execution/route.ts:150–160 accepted; extra reads below ratified as recorded.
**Reads beyond the list:** validate-execution/route.ts:150–162; capture-endpoint-baseline.ts:46–62 & :232–246; verify-arbitrum-addresses.mjs:230–242; verify-arbitrum-chainlink-feeds.mjs:135–142 & :170–185 (flagged line is :179); grok-dispatch.test.mjs:1–8 & :315–326 (flagged :322); monitoring-loop.test.ts:395–410; alert-wrapper/kv-rate-limiter/log-swap import lines; `grep forLog` in rpc-chain-identity.test.ts. All read-only.
