# Feedback — fix/codeql-log-injection

Log calls only; no control-flow / return / throw / KV-key / rate-limit change. No dismissals, no PR.

**1 Sanitiser** `src/lib/log-sanitize.ts` `forLog(value, max=200)` (inline `/[\r\n]/g`→' ', strip C0+DEL, truncate).
Tests (`log-sanitize.test.ts`): CR/LF replaced · tab/ESC/C0/DEL stripped · truncation · non-string input · clean text untouched.
Reconciled: rpc-chain-identity's private `forLog` removed; sinks now `forLog(sanitizeUpstreamError(x), Infinity)` (redaction kept, no truncation: mismatch msg >200 chars, test-pinned).

**2 Per alert** (file:line, before → after)
- #8 source-state-machine:195 `warn(\`…${id}…\`, msg)` → `warn('…%s…', forLog(id), forLog(msg))` · #9 :252 same pattern
- #22 :85 · #23 :89 · #24 :93 `${sourceId}` → `${forLog(sourceId)}` · #25 = #8 · #26 :218 sourceId+message · #27 :246 id+reason · #28 = #9
- #15 log-swap/route.ts:129 `${tokenInSymbol} (${tokenIn})` → both via `forLog`
- #39 kv-rate-limiter:131 · #40 :135 `${key}` → `${forLog(key)}` (inline; `key`/`redisKey` untouched)
- #17 alert-wrapper:269 · #18 :288 · #19 :299 · #20 :324 · #21 :333 → `forLog(category|sourceId|err msg)`
- #57 rpc-chain-identity:269 · #58 :273 → shared `forLog` (was local, not modelled by CodeQL)
- #4 monitoring-loop.test.ts:~403 `includes('api.telegram.org')` → `new URL(..).hostname ===` (try/catch) · #59 grok-dispatch.test.mjs:322 `execFileSync('cat')` → `readFileSync`
- #14 capture-endpoint-baseline.ts:240 `if(!existsSync(dir)) mkdirSync` → unconditional `mkdirSync(dir,{recursive:true})` (line 209 existsSync on outputPath remains; may keep #14 open)
- Skipped: #11 (rejectUnauthorized:false is the point; owner dismissal, comment only) · #42, #54 (fixed-path write / manual RPC script; no 1–2 line fix, owner dismissal)
- Dead `// codeql[...]` replaced with pointer comments: monitoring-loop.test.ts, capture-endpoint-baseline.ts:53. NOT touched: api-auth.ts:93 (OUT), swap/route.ts:253 (OUT), fingerprint-validator.ts:318 (read-only), validate-execution/route.ts:157 (not on read list).
- Also replaced the false "SOURCES enum, never user input" comments in source-state-machine (id also comes from `kv.smembers`).

**3 KV/rate-limit unchanged** `kv-rate-limiter.test.ts` › "[CodeQL log-injection] only the LOG line is sanitised": "KV path: Redis key stays byte-identical" (zrem arg = `ratelimit:<raw hostile key>`), "fallback path: map key is the raw key and ceil(limit/2) math is unchanged" (4→1,0,blocked), "fallback log lines carry no CR/LF/ESC".

**4 #12 evidence** (`fingerprint-validator.ts`, read-only): `tls.connect(..., {rejectUnauthorized:false})` at :319. The client never reads or writes the stream: no `data` listener, no `.write`, no HTTP request (grep of `socket.`: only :321 `getPeerCertificate(true)`, :338 `destroy`, :340 `on('error')`, :341 `setTimeout`). Only cert fields used: `fingerprint256`, `subjectaltname`, `issuer.CN`, `subject.CN` (:322–335). Socket destroyed in `finally` (:338), on error and on timeout. Handshake-only; no response body exists. (Callers of `captureLiveTLS` not inspected — outside read list.)

**5 Verify** vitest: main e4b2def 4401 passed/291 files → branch 4409 passed/292 files (+8 new tests) · tsc 0 errors · eslint 94 warnings = baseline (delta 0) · diff --stat vs origin/main: 12 files, +146/−48 (+ this file).
Caveat: CodeQL recognition of the `forLog` helper is unverified until CI runs on the owner's PR.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/codeql-log-injection
