# Feedback — fix/quote-limiter-music-toggle

- [x] C1 `d2233bb` limiter  - [x] C2 `75c79b1` hung-KV  - [x] C3 `0d7f1a5` music  - [x] verify  - [x] push (no PR)

**1. S-8** — `route.ts` GET+POST: `withTimeout(checkRateLimit(..),3s).catch(onKvTimeout({allowed:true}))` →
`await checkRateLimitWithin(\`quote:${ip|postIp}\`, QUOTE_RATE_LIMIT.limit, QUOTE_RATE_LIMIT.windowMs)`; key, 429 bodies, headers
untouched; `withTimeout`/`onKvTimeout` stay (halt check). Hung-KV tests (`route.limiter.test.ts`, GET and POST): calls 1-15 → 200,
16th → 429 (body + `X-RateLimit-*` as before), 2nd IP → 200; healthy KV → pipeline used 20/20, fallback map empty. Old route: 4/5 fail.

**2. Hung KV** — PREMISE DELTA: nothing waits unbounded. Four SEQUENTIAL bounds add up: halt `route.ts:~121/256` 3 s + limiter 1 s
(3 s before C1 = the auditor's 12 s) + cache read `meta-quote-cache.ts` `getCachedMetaQuote` 3 s + cache write `setCachedMetaQuote` 3 s.
Measured before: GET 10015 ms, POST 10007 ms. Fix (owner may overrule): cache read/write bound `CACHE_KV_TIMEOUT_MS = 500` (≤ the
route's 3 s), write skipped when the READ timed out. After: GET 4516 ms, POST 4509 ms (`route.hung-kv.test.ts`, real halt/limiter/cache, mock sources).
Halt-check semantics unchanged: halted → 503; KV timeout or error → fail open (3 s). Cache: fail open (= miss).
`/api/v1/quote` shares `meta-quote-cache.ts`, so it gets the same bound (no other change to it).

**3. Music** — cause CONFIRMED, plus why `Fabs.tsx`'s `stopPropagation` did not help: Next hydrates INTO `document`
(`next/dist/client/app-index.js:33,290`), so React's handler and v1 `BackgroundMusic`'s listener are siblings on one node; the old
parity test mounts in a `<div>` and so passed. Diff (`sounds.ts:52`): `if (bgMusic) return` → `if (bgMusic || !bgMusicEnabled) return`.
`music-first-click.test.tsx` (click delivered to `document` as in prod): (a) first click on ♫ → no background.mp3 play, icon off,
aria-pressed false; (b) on again → 1 play; (c) v1 first click plays, v1 toggle pauses; (d) keydown / scroll after off → silent.
Pre-fix (a) and both (d) fail. Comment-only edit in `Fabs.tsx` (the old one was wrong).

**4. Verify** — suite 463 files / 8249 tests pass (+14 new); eslint 92 warnings/0 errors = origin/main (delta 0); `tsc --noEmit` clean;
`next build` OK; parity-sweep, content-parity and rpc-budget are in the suite (green); `check:agents-parity` OK; CodeQL
security-extended 13 → 13, 0 new / 0 fixed. `git diff --stat origin/main..HEAD`: 10 files, +370/−25.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/quote-limiter-music-toggle

**Concern** — a live-but-slow Upstash read (> 500 ms) is now a cache miss → extra live fan-out (the dampener coalesces it).
**Process** — my `sed` left an apostrophe in a test title (C2 file would not parse); `tsc` caught it, folded into C2 before any push.
