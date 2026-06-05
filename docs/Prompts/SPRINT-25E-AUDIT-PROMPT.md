# Audit Prompt — Sprint 25E (P154–P155)

> **Date:** 2026-05-20
> **Branch:** `fix/quote-routing-and-sim`
> **Commits:** `cfba711` (P154), `74ed2e1` (P155)
> **Spec:** `docs/Prompts/SPRINT-25E.md`
> **Prior sprint:** Sprint 25D audited (APPROVED 0C/0H/0M/0L/3 INFO, report at `Audits/SPRINT-25D-AUDIT.md`)

---

## Context

Sprint 25D fixed the `/api/rpc` 403s (blacklist) and FeeCollector bypass
(all sources). Production testing revealed two more issues:

1. Wallet extensions (MetaMask/Rainbow) consume all 60 req/min RPC rate
   budget with background polling, causing 429s that starve simulation
   `eth_call` — intermittent "swap would fail on-chain" false positives.
2. 1inch returns 403 (API key misconfigured on Vercel — separate ops fix).
   The adapter throws `1inch 403` with no upstream context, making
   diagnosis impossible from the user-facing error message.

---

## Scope — what to audit

### P154 — RPC_RATE_LIMIT 60 → 300/min (commit `cfba711`)

**File:** `src/lib/kv-rate-limiter.ts`

**Changes:**
- `RPC_RATE_LIMIT.limit` changed from 60 to 300
- Comment added explaining rationale (blacklist makes higher limit safe,
  wallet polling consumes ~30-50 req/min)

**Verify:**
1. Only `RPC_RATE_LIMIT` changed — `SWAP_RATE_LIMIT` (20) and `QUOTE_RATE_LIMIT` (30) unchanged
2. The sliding-window logic, fallback limiter, and KV pipeline are untouched
3. Fallback limit is now ceil(300/2) = 150 — still reasonable for degraded mode
4. No other files modified in this commit
5. 300/min is defensible: the proxy is read-only (blacklist blocks all write/sign), upstream RPC has its own limits, and 300/min per IP is standard for read proxies

**Security focus:**
- Does 300/min create a cost concern on the upstream RPC (LlamaRPC/Alchemy)?
  LlamaRPC free tier is ~300k/day. 300/min = 432k/day if sustained — could exceed.
  But this is per-IP limit, not total; real usage is much lower.
- Could an attacker abuse the read proxy at 300/min? They'd get blockchain reads
  only — no writes, no signing, no state mutation. Marginal risk.

---

### P155 — 1inch error body context (commit `74ed2e1`)

**File:** `src/lib/adapters/oneinch.ts`

**Changes:**
- `fetchQuote` (~lines 16-23): On `!res.ok`, reads the response body
  (`res.json()`) and extracts `description` or `error` field. Appends
  to the thrown Error: `1inch ${status}: ${detail}`.
- `fetchSwapData` (~lines 55-62): Same pattern.
- Non-JSON error bodies are caught silently (fallback to status-only message).

**Verify:**
1. Both call sites (`fetchQuote` and `fetchSwapData`) have the same pattern
2. The `res.json()` call is inside try-catch — non-JSON bodies don't crash
3. The status code is still the FIRST part of the error message (e.g. `1inch 403: ...`)
   so `classifyAdapterError()` heuristics in shared.ts still match correctly
4. `classifyAdapterError()` in shared.ts is NOT modified
5. No other adapters modified — only 1inch (as spec'd)
6. No change to happy-path behaviour (both functions still parse response
   with `parseJsonOrThrow` on success)

**Security focus:**
- The upstream error body is included in the thrown Error message, which
  may surface to the user via classifyAdapterError. Could 1inch's API
  return a crafted error body that causes issues? Low risk — it's a string
  from a trusted API, and it goes through our classifier which returns
  predefined messages. The raw detail only shows in server logs.

---

## Cross-cutting checks

1. **TypeScript clean** — confirm `npx tsc --noEmit` passes
2. **All tests pass** — confirm 824 pass + 19 skip, 0 fail
3. **No unrelated changes** — only `kv-rate-limiter.ts` and `oneinch.ts`
4. **No secrets or env vars changed** — confirm
5. **FEEDBACK.md** — check if the Code Agent added entries
6. **Spec compliance** — compare against `docs/Prompts/SPRINT-25E.md`

---

## Output format

Produce `Audits/SPRINT-25E-AUDIT.md` with:
- Summary table (commit, file, status)
- Findings by severity (C/H/M/L/INFO)
- Spec deviations (if any)
- Verdict: APPROVED (0C/0H) or REJECTED with required fixes

Classification: C = Critical (funds at risk), H = High (security/functionality broken),
M = Medium (correctness concern), L = Low (best practice), INFO = informational.
