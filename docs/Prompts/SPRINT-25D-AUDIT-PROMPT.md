# Audit Prompt — Sprint 25D (P152–P153)

> **Date:** 2026-05-20
> **Branch:** `fix/quote-routing-and-sim`
> **Commits:** `c627f82` (P152), `9740394` (P153)
> **Spec:** `docs/Prompts/SPRINT-25D.md`
> **Prior sprint:** Sprint 25C merged via PR #76 (commit `5b086c8` on main)

---

## Context

Sprint 25C (P149–P151) deployed to production. Two residual issues found:

1. `/api/rpc` STILL returning 403 for wagmi/viem methods not in the whitelist — the whitelist approach (P149) was insufficient because wagmi calls a growing set of methods.
2. Velora swaps revert in simulation — Augustus V6 router (`0x6A000F20005980200259B80c5102003040001068`) is NOT on FeeCollector V1's on-chain whitelist.

Sprint 25D fixes both with two commits.

---

## Scope — what to audit

### P152 — `/api/rpc` whitelist → blacklist (commit `c627f82`)

**File:** `src/app/api/rpc/route.ts`

**Changes:**
- Removed `ALLOWED_METHODS` set (18 read-only methods)
- Added `BLOCKED_METHODS` set (12 write/sign/wallet methods)
- Flipped validation logic: was `if (!ALLOWED_METHODS.has(...))` → now `if (BLOCKED_METHODS.has(...))`
- Updated JSDoc to explain the blacklist rationale
- Error message changed from `"Method ${m} not allowed"` to `"Method ${m} not allowed via proxy"`

**Verify:**
1. All 12 blocked methods are correct: `eth_sendRawTransaction`, `eth_sendTransaction`, `eth_sign`, `eth_signTransaction`, `eth_signTypedData`, `eth_signTypedData_v3`, `eth_signTypedData_v4`, `personal_sign`, `wallet_addEthereumChain`, `wallet_switchEthereumChain`, `wallet_requestPermissions`, `wallet_watchAsset`
2. No write/sign methods were accidentally omitted from the blocklist
3. Rate limiting (Upstash `checkRateLimit`) is unchanged
4. Batch request support is unchanged
5. Error response format (JSON-RPC 2.0) is still correct
6. HTTP status codes: 403 for blocked, 400 for invalid request, 429 for rate limit, 500 for internal — all unchanged
7. No other files were modified in this commit

**Security focus:**
- The blocklist must be COMPLETE — any omitted write/sign method would allow transaction submission through our proxy
- `eth_submitWork`, `eth_submitHashrate`, `miner_*`, `admin_*`, `debug_traceTransaction` (state-mutating debug methods) — are these a concern? Most public RPCs already block them, but verify the threat model
- The proxy forwards `method` strings as-is to the upstream RPC — no injection risk since JSON-RPC methods are plain strings, but confirm

---

### P153 — FEE_INCOMPATIBLE_SOURCES expansion (commit `9740394`)

**Files:**
- `src/lib/constants.ts` — `FEE_INCOMPATIBLE_SOURCES`
- `src/app/api/v1/swap/route.test.ts` — test skip alias

**Changes to `constants.ts`:**
- `FEE_INCOMPATIBLE_SOURCES` expanded from 5 entries (`'0x', 'cowswap', 'uniswapv3', 'odos', 'kyberswap'`) to 11 entries (all sources)
- Comment block rewritten with three tiers:
  - **Permanent** (2): `'0x'`, `'cowswap'` — structural mismatch
  - **Temporary — confirmed broken** (4): `'uniswapv3'`, `'odos'`, `'kyberswap'`, `'velora'` — routers verified NOT on V1 whitelist
  - **Temporary — precautionary** (5): `'1inch'`, `'openocean'`, `'sushiswap'`, `'balancer'`, `'curve'` — not individually verified
- Comment documents the side effect: ALL sources are now fee-incompatible → `/v1/swap` cannot pin or auto-select any source during the timelock window
- Comment includes revert date: 2026-05-22 (router timelocks)

**Changes to `route.test.ts`:**
- Added `itFeeCollectable = it.skip` alias with comment explaining why
- 19 happy-path tests that require a fee-collectable winner changed from `it(...)` to `itFeeCollectable(...)`
- Tests that DON'T require fee-collectable routing (validation, auth, CORS, halt, error surfacing) remain as `it(...)` and continue to run
- Revert marker: `REVERT 2026-05-22`

**Verify:**
1. All 11 entries in `FEE_INCOMPATIBLE_SOURCES` match `AggregatorName` type — no typos
2. `teraswap_order_engine` is correctly NOT in the list (it's autonomous, not routed through FeeCollector)
3. The `itFeeCollectable = it.skip` pattern is correct — `it.skip` is valid Vitest API
4. Count the skipped vs running tests: 19 skipped, remaining tests still run (824 pass + 19 skip = 843 total)
5. No production code logic was changed — only the data array and test skip markers
6. `usesFeeCollector()` in `src/lib/api.ts` reads `FEE_INCOMPATIBLE_SOURCES` — confirm it returns `false` for all 11 entries correctly
7. The comment correctly documents which entries are permanent vs temporary
8. Router addresses in comments match known addresses:
   - SwapRouter02: `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` ✓
   - Odos Router V3: `0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559` ✓
   - KyberSwap MetaAggregationRouterV2: `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` ✓
   - ParaSwap Augustus V6: `0x6A000F20005980200259B80c5102003040001068` ✓

**Security focus:**
- Revenue impact: 0.1% fee is now collected on ZERO sources until V2 goes live. This is accepted — working swaps > fee collection. Confirm the trade-off is documented.
- The precautionary expansion means we won't discover individual router whitelist failures one-by-one in production — that's the intent.
- `/v1/swap` (programmatic API) is effectively non-functional for fee-wrapped swaps during the window. The test skips cover this. Frontend swaps use direct mode (no FeeCollector) and are unaffected.

---

## Cross-cutting checks

1. **TypeScript clean** — confirm `npx tsc --noEmit` passes
2. **All tests pass** — confirm `npx vitest run` shows 824 pass + 19 skip, 0 fail
3. **No unrelated changes** — only `route.ts` (rpc), `constants.ts`, and `route.test.ts` (v1/swap) were modified
4. **No secrets or env vars changed** — confirm
5. **FEEDBACK.md** — check if the Code Agent added any feedback entries
6. **Spec compliance** — compare changes against `docs/Prompts/SPRINT-25D.md` requirements

---

## Output format

Produce `Audits/SPRINT-25D-AUDIT.md` with:
- Summary table (commit, file, status)
- Findings by severity (C/H/M/L/INFO)
- Spec deviations (if any)
- Verdict: APPROVED (0C/0H) or REJECTED with required fixes

Classification: C = Critical (funds at risk), H = High (security/functionality broken), M = Medium (correctness concern), L = Low (best practice), INFO = informational.
