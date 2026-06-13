# Sprint 9W-oracle Audit — cbETH Depeg / Manipulation Circuit-Breaker

**Date:** 2026-06-08
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-9w-oracle-depeg-breaker`
**Commits reviewed:** `f08d0cc` (V1 core evaluateDepeg), `6b4f8b6` (V2 UI useDepegCheck+consent), `070ead9` (FEEDBACK), `21ba309` (test-mock fix)
**Files changed:** 11 (+534/−17 lines)
**New files:** `src/lib/depeg-gate.ts`, `src/lib/depeg-gate.test.ts`, `src/hooks/useDepegCheck.ts`
**Tests:** +20 new `it()` blocks
**Signatures:** All 4 commits SSH-signed (SSH SIGNATURE header present, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9W-oracle Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 3 INFO

---

## ⚠️ SAFETY GATE — This sprint adds a NEW circuit-breaker on top of the existing oracle infrastructure (rule #9). It does NOT modify any existing gate.

---

## Check 1: Swap-price reference UNCHANGED — the ER feed is used ONLY for the divergence verdict ✅

The `ExchangeRatePair` interface explicitly separates the two feeds:
```typescript
market: `0x${string}`       // 9V swap-price reference — UNTOUCHED
exchangeRate: `0x${string}` // manipulation-resistant comparison leg — NEW consumer
```

**Verification:** `chainlink.ts`, `useChainlinkPrice.ts`, `price-gate.ts` have ZERO changes in this branch (confirmed via `git diff bb55dc3..21ba309`). The composed swap-price path (`fetchChainlinkPriceRaw` → `fetchSingleFeedRaw(0x806b…)`) is completely untouched. The ER feed (`0x868a…`) is read ONLY in `useDepegCheck.ts` via its own `useReadContract` calls and passed ONLY to `evaluateDepeg` — it never enters any pricing or gate function.

**Test-pinned:** `getExchangeRatePair(CBETH, 8453).market === '0x806b…'` and `!== '0x868a…'` (the ER address). ✅

---

## Check 2: Divergence formula + thresholds + consent mechanics ✅

### Formula

```typescript
divergence = Math.abs(marketPrice - exchangeRate) / exchangeRate
```

Uses the exchange rate as denominator — semantically correct (measures how far the market deviates FROM the redemption rate). Symmetric: cbETH trading at a premium OR discount triggers at the same threshold. **Test-pinned:** `evaluateDepeg(0.95, 1.0)` and `evaluateDepeg(1.05, 1.0)` produce the same `divergence`. ✅

### Thresholds

| Threshold | Value | Mode | Recoverable? |
|-----------|-------|------|-------------|
| < 2% (`DEPEG_DIVERGENCE_WARN`) | 0.02 | `'ok'` | N/A — no friction |
| 2–10% | 0.02–0.10 | `'consent'` | Yes — checkbox |
| ≥ 10% (`DEPEG_DIVERGENCE_BLOCK`) | 0.10 | `'block'` | **No** — hard block, no checkbox |

**Justification:** cbETH's normal market-vs-ER spread is well under 1% (the two feeds differed by ~0.2% in the 9V-M-01 on-chain check: 1.1344 vs 1.1320). A 2% gap is already a 10× deviation from normal, signaling an abnormal event. 10% is a near-certain depeg/manipulation — the threshold mirrors the 9J extreme-block ceiling shape. ✅

### Consent CANNOT click through the ≥10% block ✅

The `depegHardBlocked` variable is `depegCheck.mode === 'block'`, and the `depegConsentNeeded` variable is `depegCheck.mode === 'consent'` — these are mutually exclusive string values from `evaluateDepeg`. The hard-block div (SwapBox.tsx:856) renders with NO checkbox and text "This cannot be overridden." The consent div (SwapBox.tsx:867) renders ONLY when mode='consent'. **The blockReason ternary also gives `'depeg-block'` highest priority** (before `extreme`, `oracle-stale`, etc.), so even if other gates are in consent mode, the depeg hard-block wins. ✅

### Consent auto-revokes at accepted+0.5% ✅

```typescript
const depegAccepted = acceptedDepeg != null && depegCheck.divergence <= acceptedDepeg + DEPEG_CONSENT_TOLERANCE
```

Where `DEPEG_CONSENT_TOLERANCE = 0.005` (0.5%). If the user accepts at 5% divergence and it worsens to 5.6%, `5.6% > 5.0% + 0.5%` → consent revoked → must re-accept. This mirrors the 9J `PRICE_IMPACT_CONSENT_TOLERANCE` pattern exactly. **Test-pinned:** acceptance at 5%, worsening to 6% → button blocked again with `data-reason='depeg-consent'`. ✅

### Resets on trade-parameter change (the 9J pattern) ✅

`setAcceptedDepeg(null)` is called on:
- Chain switch (line 165)
- Amount change (line 483)
- Field reset (line 495)
- TokenSelector onSelect — BOTH tokenIn (line 633) and tokenOut (line 670)
- Amount set from max/preset (line 504)

This exactly mirrors the `setAcceptedDeviation(null)` calls — every place the price-impact consent resets, the depeg consent also resets. ✅

---

## Check 3: Fail-open correctness ✅

### Either leg stale/invalid → 'ok' (no depeg verdict, no false block)

`priceFromValidRound` returns null when:
- Round data undefined (feed not loaded yet)
- `answer <= 0n` (bad answer)
- `answeredInRound < roundId` (incomplete round)
- `startedAt <= 0n` (round never started)
- `nowSec - updatedAt > stalenessSec` (stale per 9V per-feed threshold)

Either null → `evaluateDepeg(null, …)` or `evaluateDepeg(…, null)` → `mode: 'ok'`. **Test-pinned** for null, 0, and negative inputs. ✅

### Can this be abused to skip a real depeg block?

**No, for defense-in-depth reasons:**

1. **A user cannot make a fresh feed appear stale.** The feed data comes from on-chain `latestRoundData` via `useReadContract` — the user would need to compromise their own RPC provider to manipulate the round tuple, which is self-griefing. If they can manipulate RPC responses, they can bypass any client-side check, including 9J.

2. **If both feeds are genuinely fresh and show a ≥10% divergence, there is no client path to suppress it.** The depeg verdict is computed from the raw round data in a single synchronous flow: `useReadContract → priceFromValidRound → evaluateDepeg`. No intervening state the user can manipulate.

3. **If the ER feed is genuinely stale (>36h old, or down), this is a feed outage — not a depeg.** The existing no-oracle calm warning + multi-source compare + on-chain minimumOutput provide the defense. False-blocking all cbETH swaps for 36h because a rarely-updated feed hasn't posted would be worse than the outage.

4. **The client-side scope is consistent with the 9J gate** — both are consent UX. The server-side defense (DefiLlama guard, on-chain minimumOutput) bounds realised loss regardless. The FEEDBACK correctly identifies that a server-side depeg check would strengthen threat (b) coverage — see 9W-I-03. ✅

---

## Check 4: Depeg legs' stricter startedAt>0 check ✅

`priceFromValidRound` checks `startedAt <= 0n` (line 92), while the existing `useChainlinkPrice` hook does NOT check `startedAt`. This is a **tightening, not a loosening** — the depeg legs are validated MORE strictly than the price display hook. The FEEDBACK correctly identifies this as intentional and conservative.

This is sound: a round with `startedAt=0` is an incomplete/phantom round that shouldn't drive a depeg verdict. Since `priceFromValidRound` is fail-OPEN (null → 'ok'), the stricter check can only cause the depeg check to produce no verdict (falling through to multi-source), never a false block. ✅

---

## Check 5: Data-driven registry — only arms assets with BOTH feeds ✅

`EXCHANGE_RATE_PAIRS_BY_CHAIN` has exactly one entry: cbETH on Base (8453). No mainnet entries. `getExchangeRatePair` returns null for:
- Any non-cbETH token on Base
- Any token on mainnet (no chain entry)
- Default chainId (mainnet)

**Test-pinned:** Base WETH → null, cbETH on chainId 1 → null, cbETH with default chainId → null. ✅

**The registry is extensible:** any future LST/LRT with both feeds gets the depeg breaker by adding an entry. No code change needed — just a registry row. ✅

**Non-cbETH swaps completely unaffected:** When `pair` is null, `enabled` is false → the four `useReadContract` hooks fire no RPC reads → returns `{ mode: 'ok', divergence: 0, symbol: '' }`. No overhead, no friction. ✅

---

## Check 6: Scope — no existing gate loosening, no contracts, mainnet byte-identical ✅

| Scope area | Changed? |
|-----------|----------|
| `chainlink.ts` (fetchChainlinkPriceRaw, validateRoundData, fetchSingleFeedRaw) | **NO** |
| `useChainlinkPrice.ts` (the swap-price UI hook) | **NO** |
| `price-gate.ts` (9J evaluatePriceGate) | **NO** |
| `defillama.ts` (validateSwapPrice, >$10k guard) | **NO** |
| `sequencer-check.ts` (isSequencerUp) | **NO** |
| `post-execution-validator.ts` | **NO** |
| `swap-selectors.ts` / `calldata-recipient.ts` | **NO** |
| `CHAINLINK_MAX_STALENESS_SEC` / `PRICE_DEVIATION_*` / `PRICE_IMPACT_*` constants | **NO** |
| Any contract / Solidity | **NO** |
| `COMPOSED_FEEDS_BY_CHAIN` / `CHAINLINK_FEEDS_BY_CHAIN` (9V/9S maps) | **NO** |
| `FEED_HEARTBEAT_SEC` | +1 entry (ER feed `0x868a…` = 86400s) — ADDITIVE only, new consumer, no existing behaviour changed |
| Mainnet | UNAFFECTED — no mainnet entries in `EXCHANGE_RATE_PAIRS_BY_CHAIN`, `getExchangeRatePair(*, 1) === null` |
| Files touched | `depeg-gate.ts` (NEW), `depeg-gate.test.ts` (NEW), `useDepegCheck.ts` (NEW), `chainlink-feeds.ts` (+44 registry), `constants.ts` (+17 thresholds), `SwapBox.tsx` (+60 consent UX), `SwapButton.tsx` (+16 block reasons), `SwapBox.test.tsx` (+101), `DigitRoller.test.tsx` (+3 mock), `chainlink.test.ts` (+18 registry tests), `FEEDBACK.md` (+28) |

---

## Check 7: FEEDBACK assessment — is the client-side breaker sufficient? ✅ (with INFO follow-up)

The FEEDBACK identifies two threat models:

**(a) Protecting the USER from unknowingly trading a depegged asset:** Fully covered by the client-side consent UX. The user sees an explicit warning or hard block. ✅

**(b) Protecting the swap-price gate from a manipulated market feed:** Partially covered. A sophisticated attacker who bypasses the UI (direct API call) could still reach the server swap path with a manipulated market price. However:
- The server-side DefiLlama guard catches large deviations from the market
- The on-chain `minimumOutput` bounds realised loss
- The attacker would need to both manipulate the Chainlink market feed AND bypass the client — the first is already expensive/difficult

**Auditor assessment:** The client-side breaker is SUFFICIENT for Phase 2 launch. A server-side check is a clean defense-in-depth follow-up (see 9W-I-03), not a gate for this sprint. This is consistent with 9J, which is also client-side.

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9W-I-01 | INFO | `useDepegCheck.ts` | The hook checks `tokenIn` first, then `tokenOut` — if BOTH tokens have exchange-rate pairs (unlikely today, possible with future LSTs), only one gets the depeg check. Acceptable for the current single-entry registry; a future multi-LST sprint should evaluate whether both tokens need independent checks. |
| 9W-I-02 | INFO | `depeg-gate.ts` | `priceFromValidRound` checks `startedAt > 0` but the existing `useChainlinkPrice` hook does not — a minor inconsistency. The depeg legs are STRICTER than the price display, which is the safe direction. A follow-up could add `startedAt > 0` to `useChainlinkPrice` for consistency, but the current state is not a vulnerability. |
| 9W-I-03 | INFO | architecture | The depeg breaker is client-side only (consent UX), matching the 9J pattern. A server-side divergence check in the `/api/swap` path would strengthen defense against threat (b) — a manipulated market feed reaching the server without the UI's consent gate. Bounded by: DefiLlama guard + on-chain minimumOutput. Recommend as a follow-up sprint (not a gate for this sprint). |

---

## Recommendation

**APPROVED for merge — 0C/0H.** The depeg circuit-breaker is a well-architected ADDITIVE safety layer that:
- Correctly uses the ER feed ONLY for comparison, not pricing
- Has a clean consent/block state machine mirroring the proven 9J pattern
- Fails open on feed outages (never a false block)
- Is data-driven and extensible for future LSTs
- Leaves every existing gate byte-identical
- Has comprehensive test coverage (20 new tests, including boundary and fail-open cases)

The server-side follow-up (9W-I-03) is a clean defense-in-depth improvement, not a security requirement for merge.
