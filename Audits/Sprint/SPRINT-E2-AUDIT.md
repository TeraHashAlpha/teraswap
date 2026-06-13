# E-2 Audit — L2 Sequencer-Uptime Gate on the Quote Path

**Date:** 2026-06-11
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `fix/e2-sequencer-quote-gate` / PR #165
**Commits reviewed:** `9604e43` (gate implementation), `d8bdaa0` (FEEDBACK)
**Files changed:** 6 (+182/−1 lines)
**Tests:** +18 lines route test, +72 lines api.test.ts
**Signatures:** Both commits SSH-signed (SSH SIGNATURE header present, author `TeraHash <t.joaocruz@gmail.com>`)

---

## E-2 Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 2 INFO

---

## ⚠️ SECURITY GATE (rule #9) — this extends the L2 sequencer-uptime protection to the quote path. The existing Chainlink price-read gate (P218) is UNTOUCHED.

---

## Check 1: ADDITIVE only — existing Chainlink price-read sequencer gate untouched ✅

**Files with ZERO changes in this branch:**

| File | Role |
|------|------|
| `src/lib/chainlink.ts` | Existing `fetchChainlinkPriceRaw` → P218 sequencer gate (line 302: `isSequencerUp`) |
| `src/lib/chains/chainlink-feeds.ts` | Feed registry (FEED_HEARTBEAT_SEC, composed feeds, ER pairs) |
| `src/lib/price-gate.ts` | 9J evaluatePriceGate |
| `src/lib/defillama.ts` | DefiLlama validation + >$10k guard |
| `src/lib/constants.ts` | Thresholds (PRICE_DEVIATION, DEPEG, CHAINLINK_MAX_STALENESS) |
| `src/app/api/swap/route.ts` | Swap build path |
| All adapter files | quote/swap sourcing |

The existing P218 gate in `chainlink.ts` (line 302) continues to call `isSequencerUp(chainId, getPublicClientForChain(chainId))` before any Chainlink price read. This is completely untouched. The E-2 change adds a SECOND invocation of the same `isSequencerUp` function at the TOP of `fetchMetaQuote` — a new consumer, not a replacement. ✅

---

## Check 2: Placement and refusal semantics ✅

### Gate placement: top of `fetchMetaQuote`, before cache and rate limiter

```typescript
// In fetchMetaQuote():
if (chainId != null && chainId !== DEFAULT_CHAIN_ID) {
  const seqUp = await isSequencerUp(chainId, getPublicClientForChain(chainId))
  if (!seqUp) {
    throw new SequencerDownError(chainId)
  }
}
```

**Before the quote cache** — so a cached quote from before the outage cannot be served once the check flips. The 30s `isSequencerUp` cache bounds detection latency (same cache both gates share — inherited, not new).

**Before the rate limiter** — so refused requests don't consume outbound budget.

**Covers every caller** — `fetchMetaQuote` is the sole quote-sourcing entry point. The `/api/quote` route (GET + POST) catches `SequencerDownError` and maps it to a typed HTTP response. Any future server caller of `fetchMetaQuote` inherits the gate automatically.

### Refusal shape

```
HTTP 503  { error: "Base sequencer is down or recovering — quotes are paused until it stabilizes.", sequencerDown: true }
Retry-After: 60
```

The `sequencerDown: true` flag is a typed discriminator the client can use for a calm "quotes paused" UX (vs. generic error). `Retry-After: 60` tells well-behaved clients to back off for 1 minute. ✅

### Sequencer down / grace window / up — matches the price-read gate exactly

Both gates call the identical `isSequencerUp` function. Its logic:

```typescript
const isUp = answer === 0n              // 0 = up, 1 = down
const sinceStartedSec = Math.floor(Date.now() / 1000) - Number(startedAt)
up = isUp && sinceStartedSec >= SEQUENCER_GRACE_PERIOD_SEC  // 3600s
```

| Sequencer state | `isSequencerUp` | Quote gate | Price-read gate |
|----------------|-----------------|------------|----------------|
| Down (`answer=1`) | `false` | REFUSE (SequencerDownError) | REFUSE (no price) |
| Up but within 1h grace | `false` | REFUSE | REFUSE |
| Up and past grace | `true` | PASS | PASS |
| RPC error on feed read | `false` (fail-safe) | REFUSE | REFUSE |
| Mainnet (no feed) | `true` (always) | SKIP (never consulted) | SKIP |

The gates are semantically identical. ✅

---

## Check 3: Base sequencer feed address verified on-chain ✅

Registry address: `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` (Base, chainId 8453).

FEEDBACK documents on-chain verification via `cast`:
- `cast call 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433 "description()(string)"` → **"L2 Sequencer Uptime Status Feed"**
- `decimals()` → 0
- `latestRoundData` → answer=0 (up), startedAt well past the grace window

This is the genuine Chainlink L2 Sequencer Uptime Status Feed on Base, verified by on-chain `description()` (the 9V lesson — directory-by-name is not evidence). The address is used by BOTH the existing P218 price-read gate AND this new quote gate — it is not a new address, just a new consumer. ✅

---

## Check 4: Mainnet path byte-identical ✅

The gate condition is:
```typescript
if (chainId != null && chainId !== DEFAULT_CHAIN_ID) { ... }
```

- `chainId === 1` → condition false → gate skipped
- `chainId === undefined` (omitted by callers) → condition false → gate skipped

**Test-pinned:** "NEVER consults the sequencer gate on mainnet (byte-identical: explicit 1 and omitted)" — `isSequencerUpMock` is never called for either `chainId: 1` or `chainId: undefined`. ✅

---

## Check 5: Negative-path tests ✅

### api.test.ts (fetchMetaQuote level)

| Test | Scenario | Assertion |
|------|----------|-----------|
| "REFUSES a Base quote when the sequencer is down or in the recovery grace window" | `isSequencerUp` returns false | Rejects with `SequencerDownError` instance, `isSequencerUp` called with `(8453, …)` |
| "proceeds past the gate to quote sourcing when the sequencer is up" | `isSequencerUp` returns true | Adapters reached (sourcing error, NOT sequencer error), error is NOT `SequencerDownError` |
| "NEVER consults the sequencer gate on mainnet" | chainId 1 and undefined | `isSequencerUp` never called |

### route.test.ts (HTTP level)

| Test | Scenario | Assertion |
|------|----------|-----------|
| "maps SequencerDownError to a calm 503 JSON with sequencerDown: true" | `fetchMetaQuote` rejects with `SequencerDownError(8453)` | Status 503, body `{ sequencerDown: true, error: /Base sequencer is down/ }`, `Retry-After: 60` |

All negative paths covered: down, grace, up, mainnet-unchanged, HTTP mapping. ✅

---

## Check 6: No contract/adapter/other-gate changes, no NEXT_PUBLIC_ leak ✅

- **Zero changes** to any adapter, contract, swap route, oracle gate, or DeFi gate (verified — `git diff` returns empty for all listed paths)
- **No `NEXT_PUBLIC_` references** in the diff (verified — grep returns empty)
- The only new exports are `SequencerDownError` (from `sequencer-check.ts`, re-exported via `api.ts`) — a typed Error class, not a secret or config value

---

## FEEDBACK Open Questions — Auditor Decisions

### Q1: Does the swap-build path (`/api/swap`) need its own explicit sequencer gate?

**Auditor ruling: NOT REQUIRED for merge; recommend as a clean follow-up (E2-I-01).**

Reasoning:
1. **The quote gate is upstream.** A user cannot reach the swap-build path without first obtaining a quote. The quote path is now gated — so no fresh quote can be obtained during a sequencer outage. A swap attempt with a stale (pre-outage) quote will fail at the oracle-validation stage.
2. **The Chainlink price-read gate (P218) is the secondary line.** `fetchChainlinkPriceRaw` already calls `isSequencerUp` before reading any price. A swap-build that reaches the price-validation step will be caught there.
3. **A direct API caller** (bypassing the UI) could theoretically call `/api/swap` with parameters from a cached/stale quote. But the oracle gate catches stale prices, and the on-chain `minimumOutput` bounds realised loss.
4. **Adding the gate is a one-liner** (same pattern as the quote gate) — clean defense-in-depth follow-up, not a security requirement.

### Q2: 30s cache detection latency

**Auditor ruling: ACCEPTABLE (inherited, not new).**

The `isSequencerUp` 30s cache is shared between the price-read gate and the quote gate. Both gates can serve results for up to ~30s after a sequencer transition. This is the same latency budget the price-read gate has always operated under. The 30s TTL is a practical balance between RPC cost and detection speed. No change needed.

### Q3: Gate placement (in-lib vs route-level)

**Auditor ruling: CORRECT as implemented.**

Gating inside `fetchMetaQuote` covers every caller (the route GET+POST, any future server caller). The route adds the HTTP-shaped response (503, typed JSON, Retry-After). `/api/v1/*` is unaffected (explicitly mainnet-only, rejects non-1 chainIds before quoting). This is sound architecture.

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| E2-I-01 | INFO | `/api/swap` | The swap-build path does not have its own explicit sequencer refusal. Defense-in-depth: the quote gate (upstream) + the oracle price-read gate (P218, inline) provide layered coverage. A one-line explicit gate in the swap route would strengthen the belt-and-suspenders. Recommend as a follow-up, not a gate for this PR. |
| E2-I-02 | INFO | `isSequencerUp` cache | 30s cache means quotes can be served for up to ~30s after a sequencer goes down. Same latency budget as the existing price-read gate (inherited, not new). Acceptable trade-off between RPC cost and detection speed. |

---

## Recommendation

**APPROVED for merge — 0C/0H.** The sequencer-uptime gate on the quote path is a well-placed, additive safety layer that:
- Reuses the existing `isSequencerUp` function VERBATIM (same semantics, same grace window, same fail-safe)
- Is placed BEFORE the quote cache and rate limiter (correct ordering)
- Produces a typed, calm refusal (503 + `sequencerDown: true` + `Retry-After: 60`)
- Leaves mainnet byte-identical (never consulted for chainId 1/omitted — test-pinned)
- Leaves every existing gate (P218 price-read, 9J, 9W depeg, DefiLlama) untouched
- Has comprehensive test coverage (down/grace/up/mainnet-unchanged/HTTP-mapping)
- Uses the on-chain-verified feed address (`0xBCF852…`, confirmed via `cast description()`)
- Introduces no new dependencies, no NEXT_PUBLIC_ leaks, no adapter or contract changes

The swap-build path explicit gate (E2-I-01) is a clean follow-up, not a blocker.
