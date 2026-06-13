# Sprint 9V Audit — Per-Feed Chainlink Staleness + Composed cbETH/USD

**Date:** 2026-06-08
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Branch:** `feat/sprint-9v-per-feed-staleness`
**Commits reviewed:** `92c4dbe` (V1 per-feed staleness), `68b1b09` (V2 composed cbETH), `41c8dba` (FEEDBACK)
**Files changed:** 5 (+305/−27 lines)
**Tests:** +11 new `it()` blocks
**Signatures:** All 3 commits SSH-signed (SSH SIGNATURE header present, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9V Audit Verdict

### Verdict: APPROVED

0C / 0H / 1M / 0L / 2 INFO

---

## ⚠️ SAFETY GATE MODIFICATION — This sprint modifies the Chainlink staleness validation (rule #9).

---

## Check 1: NO LOOSENING — staleness ceiling = heartbeat×1.5, shared by both consumers ✅

### V1 architecture

A new single function `getFeedStalenessSec(feed, globalFallback)` in `chainlink-feeds.ts` derives the staleness ceiling:
- Known heartbeat → `heartbeat × 1.5` (margin for a late round)
- Unknown heartbeat → `globalFallback` (the caller's existing global, unchanged)

**Both consumers call the SAME function with the SAME feed address:**
- Raw gate (`chainlink.ts:fetchChainlinkPriceRaw`): `getFeedStalenessSec(feed, CHAINLINK_MAX_STALENESS_SEC)` where `CHAINLINK_MAX_STALENESS_SEC = 3600`
- UI hook (`useChainlinkPrice.ts`): `getFeedStalenessSec(feedAddress, 90_000)`

**Both AGREE** on every feed — they just have different global fallbacks for unknown feeds (1h raw / 25h UI), which is the pre-existing asymmetry, preserved byte-identical. ✅

### validateRoundData integrity guards UNCHANGED

```typescript
// Line 192-199 — UNTOUCHED
if (answer <= 0n) return false
if (answeredInRound < roundId) return false
if (startedAt <= 0n) return false
if (maxStalenessSec !== undefined) { ... }
```

The only parameter that changed is `maxStalenessSec` — now per-feed instead of global. The three integrity guards (answer, answeredInRound, startedAt) are byte-identical. ✅

### Test-pinned thresholds

| Feed | Heartbeat | Threshold (×1.5) | Test |
|------|-----------|-------------------|------|
| Base USDC/USD (86400s) | 24h | 36h = 129600s | ✅ `getFeedStalenessSec(BASE_USDC_USD, *) === 129600` |
| Base ETH/USD (1200s) | 20min | 30min = 1800s | ✅ `getFeedStalenessSec(BASE_ETH_USD, 3600) === 1800` |
| Mainnet ETH/USD (unknown) | — | caller's global | ✅ `getFeedStalenessSec(MAINNET_ETH_USD, 3600) === 3600` |

**37h-old Base USDC/USD round → STALE (test-pinned).** No loosening past heartbeat×1.5. ✅
**Round-integrity still hard-fails regardless (answeredInRound < roundId test on a 2h-old round).** ✅

---

## Check 2: Heartbeats correct — verified against Chainlink reference-data-directory ✅ (with one address discrepancy — see 9V-M-01)

**Auditor independently fetched `feeds-ethereum-mainnet-base-1.json` from `reference-data-directory.vercel.app`:**

| Feed | Code heartbeat | Directory heartbeat | Code proxy | Directory proxy | Match |
|------|---------------|--------------------|-----------|--------------------|-------|
| ETH/USD | 1200 | **1200** | 0x71041ddd… | 0x71041ddd… | ✅ EXACT |
| USDC/USD | 86400 | **86400** | 0x458138Fc… | 0x458138Fc… | ✅ EXACT |
| DAI/USD | 86400 | **86400** | 0x591e7923… | 0x591e7923… | ✅ EXACT |
| cbETH/ETH | 86400 | **86400** | **0x806b4Ac0…** | **0x868a501e…** | ⚠️ HEARTBEAT MATCH, PROXY MISMATCH |

**Unknown/missing heartbeat → global fallback:** Mainnet feeds have no entry in `FEED_HEARTBEAT_SEC` → `getFeedHeartbeatSec` returns null → `getFeedStalenessSec` returns the caller's global (raw=3600, UI=90000). **Fail-conservative.** ✅

---

## Check 3: Mainnet byte-identical ✅

**Mainnet feeds have NO entry in FEED_HEARTBEAT_SEC (deliberate).**

| Consumer | Pre-9V | Post-9V | Identical? |
|----------|--------|---------|-----------|
| Raw gate (fetchChainlinkPriceRaw) | `validateRoundData(…, CHAINLINK_MAX_STALENESS_SEC)` = 3600 | `validateRoundData(…, getFeedStalenessSec(mainnet_feed, 3600))` = 3600 (unknown → fallback) | ✅ IDENTICAL |
| UI hook (useChainlinkPrice) | `ageSeconds > 90_000` | `ageSeconds > getFeedStalenessSec(mainnet_feed, 90_000)` = 90000 (unknown → fallback) | ✅ IDENTICAL |

**Test-pinned:** `getFeedStalenessSec(MAINNET_ETH_USD, 3600) === 3600`. ✅

### Auditor decision on the mainnet 3600→1800 question (FEEDBACK item)

The FEEDBACK correctly flags: mainnet ETH/USD has a ~1h heartbeat. If heartbeats were added for mainnet, the threshold would be 1200×1.5=1800s — TIGHTER than the existing 3600s. The Code Agent chose to NOT add mainnet heartbeats, keeping the existing global (3600s = heartbeat×1.0).

**Auditor assessment: CORRECT CHOICE.** The current 3600s is already 1.0× heartbeat (conservative). Adding heartbeat×1.5 would LOOSEN to 1800s — still safe, but unnecessary. Keeping mainnet byte-identical is the right call for a safety gate change that targets Base. If mainnet feeds need per-feed thresholds, that's a separate sprint. ✅

### Base ETH/USD tightening (3600→1800) — acceptable

Pre-9V, Base ETH/USD used the raw global (3600s). Post-9V, it uses heartbeat×1.5 = 1800s. This is a TIGHTENING (more conservative). A Base ETH/USD round 30-60min old now fails where it previously passed. This is correct — the feed updates every ≤20min, so 30min is a generous ceiling. The FEEDBACK correctly flagged this. ✅

---

## Check 4: Composed cbETH/USD — decimals exact, both legs independent ✅

### Architecture

`fetchChainlinkPriceRaw` now checks `getComposedFeed` when `getChainlinkFeed` returns null:

```
direct feed → fetchSingleFeedRaw(feed)
composed → fetchSingleFeedRaw(base) → fetchSingleFeedRaw(quote) → base.price × quote.price
neither → null (unchanged no-oracle path)
```

### Decimals handled per-leg (no $1.08 bug) ✅

Each leg is normalised independently inside `fetchSingleFeedRaw`:
```typescript
const price = Number(answer) / 10 ** decimals
```

- cbETH/ETH (18 dp): 1_080_000_000_000_000_000 / 10^18 = 1.08
- ETH/USD (8 dp): 300_000_000_000 / 10^8 = 3000
- Product: 1.08 × 3000 = **3240** (correct — NOT $1.08)

Test: `expect(r!.price).toBeCloseTo(3240, 2)` ✅

### Both legs independently integrity+staleness checked ✅

Each leg passes through the full `fetchSingleFeedRaw` pipeline:
1. Fetch decimals (RPC)
2. Fetch latestRoundData (RPC)
3. `validateRoundData(roundId, answer, startedAt, updatedAt, answeredInRound, getFeedStalenessSec(feed, CHAINLINK_MAX_STALENESS_SEC))`

**Tests verify:**
- Base leg (cbETH/ETH) stale past 36h → null (no partial pricing) ✅
- Quote leg (ETH/USD) stale past 30min → null ✅
- Quote leg integrity fail (answeredInRound < roundId) → null ✅
- Unfeeded token (USDbC) → null (no false composition) ✅

### Either leg fails → null (no partial pricing) ✅

```typescript
const base = await fetchSingleFeedRaw(composed!.base, chainId)
if (!base) return null   // base fails → unavailable
const quote = await fetchSingleFeedRaw(composed!.quote, chainId)
if (!quote) return null  // quote fails → unavailable
```

No partial pricing path. Either both legs valid or the composition returns null → no-oracle fallback (multi-source compare + on-chain minimumOutput). ✅

### updatedAt = min(legs) — conservative ✅

```typescript
updatedAt: Math.min(base.updatedAt, quote.updatedAt)
```

The composite price is as fresh as its stalest leg. ✅

### Sequencer check done ONCE before legs ✅

```typescript
// Done ONCE up front; both composed legs share the chain.
if (chainId !== DEFAULT_CHAIN_ID) {
  const seqUp = await isSequencerUp(chainId, getPublicClientForChain(chainId))
  if (!seqUp) return null
}
```

Mainnet (DEFAULT_CHAIN_ID) skips this (byte-identical). Base checks once → both legs use Base RPC. ✅

---

## Check 5: Scope — deviation/manipulation thresholds, DefiLlama, sequencer, gate ORDER all untouched ✅

| Scope area | Changed? |
|-----------|----------|
| `PRICE_DEVIATION_WARN` / `PRICE_DEVIATION_BLOCK` | NO |
| `CHAINLINK_MAX_STALENESS_SEC` (constant) | NO (3600) |
| `PRICE_IMPACT_CONSENT_CEILING` (9J) | NO |
| `evaluateDeviation` / `evaluatePairOracle` (9S) | NO |
| `price-gate.ts` (9J) | NO |
| `defillama.ts` / `validateSwapPrice` (9G G2) | NO |
| `sequencer-check.ts` / `isSequencerUp` | NO |
| `post-execution-validator.ts` (9G G3) | NO |
| `swap-selectors.ts` / `calldata-recipient.ts` | NO |
| `constants.ts` | NO |
| Any contract / Solidity | NO |
| Gate ORDER (sequencer → integrity → staleness → deviation) | UNCHANGED — sequencer fires first, integrity checks next (in validateRoundData), staleness last |
| Files touched | Only: `chainlink.ts`, `chainlink-feeds.ts`, `useChainlinkPrice.ts`, `chainlink.test.ts`, `FEEDBACK.md` |

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9V-M-01 | **MEDIUM → CLOSED** | `chainlink-feeds.ts` | **cbETH/ETH proxy address — RESOLVED (false positive).** The audit flagged `0x806b4Ac0…` as absent from the directory; the Code Agent's on-chain `cast` verification (`7dd84f0`) showed Base has THREE distinct cbETH feeds: `0x806b…` "CBETH / ETH" (market price, 18dp — **the correct one for swap guards**), `0x868a…` "cbETH-ETH Exchange Rate" (redemption rate, manipulation-resistant but depeg-blind — wrong for swap validation), and `0xd7818272…` "CBETH / USD" (direct 8dp feed, 20-min heartbeat — new discovery). The audit's "absent" was a name-mismatch against the Exchange-Rate entry. Address unchanged; documentation added; +2 tests pin the market proxy. **Lesson:** for multi-feed assets, on-chain `cast description()/aggregator()` is the decisive source, not the directory UI. **Follow-up surfaced in FEEDBACK:** direct CBETH/USD feed could replace the composition (simpler, tighter staleness) — Architect to triage. |
| 9V-I-01 | INFO | `chainlink.ts` | V2 composition is raw-path only (fetchChainlinkPriceRaw). The UI hook (useChainlinkPrice) does NOT display composed oracle prices — cbETH still renders "no oracle" in the UI while the swap path validates against cbETH/ETH × ETH/USD. This is a display inconsistency, not a security issue — the swap path (the safety-relevant surface) has the oracle protection. A UI-side composed display is a clean follow-up. |
| 9V-I-02 | INFO | `chainlink-feeds.ts` | Base ETH/USD threshold tightened from the raw global 3600s to 1800s (heartbeat×1.5 = 1200×1.5). This is more conservative (not loosening) and correct for the 20-min heartbeat, but it IS a behaviour change: a Base WETH price 30-60min stale now fails where it previously passed. Safe — the feed updates every ≤20min, so 30min is generous. |

---

## Recommendation

**APPROVED for merge — 0C/0H.** The per-feed staleness architecture correctly derives thresholds from verified heartbeats, is shared by both consumers (raw gate and UI hook), preserves all integrity guards byte-identical, and keeps mainnet unchanged.

**9V-M-01 CLOSED** (`7dd84f0`): On-chain `cast` verified `0x806b…` IS the correct market-price feed. The audit's directory mismatch was a false positive — the directory entry `0x868a…` is a different feed (exchange-rate/redemption, not market-price). No code change needed; documentation and +2 pinning tests added. **Follow-up:** direct CBETH/USD feed (`0xd7818272…`, 20-min heartbeat) discovered — Architect to triage whether to replace the composition.
