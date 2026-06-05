# Sprint 9J Audit — Swap UX/Reliability (Deviation Gate + Timeout + Tooltips)

**Date:** 2026-06-03
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Audit brief:** `Audits/SPRINT-9J-AUDIT-BRIEF.md`
**Branch:** `feat/sprint-9j-swap-ux`
**Commits reviewed:** `0d33c04` (J1 model), `6333466` (J1 UI), `ec6b1c4` (J2), `f2b17be` (J3), `14807a8` (review hardening), `f95ff0a` (docs)
**Baseline:** origin/main @ `4aa5aff` (prod)
**Files changed:** 25 (+1047/−55 lines)
**Tests:** +45 new `it()` blocks (1399 → 1443 claimed, consistent with delta)
**Signatures:** All 6 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9J Audit Verdict

### Verdict: APPROVED

0C / 0H / 0M / 0L / 2 INFO

---

## J1 — Deviation Gate (PRIMARY FOCUS) ✅

### Critical Check 1: Genuine oracle protection still hard-blocks ✅

| Protection | Mechanism | Still blocks? | Verified |
|-----------|-----------|--------------|----------|
| Stale feed (`updatedAt` too old) | `useChainlinkPrice` → `oracleIntegrityFailed: true` | **YES** — `evaluatePriceGate` → `mode: 'block', reason: 'oracle-integrity'` | ✅ Test: "a STALE / invalid-round oracle hard-BLOCKS" |
| Invalid price (`answer <= 0`) | `useChainlinkPrice` → `oracleIntegrityFailed: true` | **YES** — same path | ✅ Hook sets flag |
| Stale round (`answeredInRound < roundId`) | `useChainlinkPrice` → `oracleIntegrityFailed: true` | **YES** — same path | ✅ Hook sets flag |
| Extreme deviation (>25% on healthy oracle) | `evaluatePriceGate` → `deviation > PRICE_IMPACT_CONSENT_CEILING` | **YES** — `mode: 'block', reason: 'extreme-deviation'` | ✅ Test: "EXTREME deviation ... HARD block" |
| Cross-source manipulation | Server-side DefiLlama `priceGuardBlocked` | **YES** — completely untouched by 9J | ✅ Not in diff |
| On-chain minimum output | Smart contract `minimumOutput` | **YES** — not modified | ✅ Not in diff |

**Integrity failure takes precedence:** Test "integrity failure takes precedence even if a deviation is also present" → `mode: 'block'`. ✅

### Critical Check 2: Reference price is NOT self-referential ✅

The gate's reference price is the **Chainlink oracle spot** — an external, on-chain price feed the route cannot manipulate. The deviation is computed as `|executionPrice - chainlinkPrice| / chainlinkPrice` in `useChainlinkPrice` (unchanged). The CLASSIFICATION of the result is what changed:

- **Before:** deviation ≥ 2% → indefinite hard-block ("WAITING"), regardless of oracle health.
- **After:** deviation ≥ 2% on a HEALTHY oracle → informed consent (the deviation IS the trade's price impact). Deviation on a BROKEN oracle → hard-block.

The gate is NOT self-referential: the aggregator's execution rate (which includes price impact) is compared against Chainlink (an external oracle). On a healthy oracle, the gap is the trade's own slippage — expected and user-accepted. A malicious/illiquid route cannot inflate "price impact" to launder a real oracle deviation because the oracle itself is intact (integrity checks pass first). ✅

### Critical Check 3: Informed consent is bounded, cannot dismiss hard-blocks ✅

**Two distinct code states in SwapBox:**

1. **`oracleIntegrityBlocked` (or `isExtremeBlock`)** → renders danger banner with NO checkbox, NO way to proceed. Button text: "Oracle data unsafe — swap blocked" or "Price deviation too high — blocked". `disabled: true`. **Cannot be clicked through.** ✅

2. **`priceImpactConsentNeeded && !priceImpactAccepted`** → renders warning banner WITH checkbox: "I understand the price impact and want to proceed." Button text: "Confirm price impact to swap". `disabled: true` until checkbox checked. ✅

**Consent auto-revokes on escalation (review F1):** `acceptedDeviation` stores the NUMERIC deviation accepted, not a bare boolean. If a quote refresh worsens the deviation beyond `accepted + PRICE_IMPACT_CONSENT_TOLERANCE` (0.5%), `priceImpactAccepted` flips false and the checkbox re-arms. ✅

**Consent resets on:** token change, amount change, token swap, chain switch. ✅

**Consent ceiling (review F2):** Deviation > `PRICE_IMPACT_CONSENT_CEILING` (25%) on a healthy oracle → hard-block (`mode: 'block', reason: 'extreme-deviation'`). Beyond plausible price impact → treated as manipulation. ✅

### Critical Check 4: Chain-aware, mainnet byte-identical, no 9G/9H regression ✅

- The price-gate classifier operates on `PriceCheck` which includes chain-aware Chainlink data (from 9G). Chain-agnostic classification — works on both chains. ✅
- No changes to: FeeCollector, router whitelist (`chains/routers.ts`), selector allowlist (`swap-selectors.ts`), calldata-recipient validation, adapter URLs, sequencer check, or any 9G/9H file. ✅
- Mainnet byte-identical except the intended gate behavior (hard-pause → consent for price-impact; hard-block for integrity). ✅

### Critical Check 5: No fee/router/calldata changes ✅

The diff touches: `price-gate.ts` (new), `useChainlinkPrice.ts` (adds flag), `chainlink.ts` (adds interface field), `SwapBox.tsx` (replaces hard-block with gate), `SwapButton.tsx` (blockReason enum), `constants.ts` (thresholds), `/api/swap/route.ts` (timeout), adapter files (retry/signal), `InfoTooltip` (new). **Zero changes** to FeeCollector, router whitelist, or selector allowlist. ✅

---

## J2 — Swap-Build Timeout/Retry (sanity) ✅

| Check | Result |
|-------|--------|
| Timeout fires under max duration | **PASS** — 12s × 2 attempts = 24s max, inside `maxDuration = 60` |
| No key leakage in error body | **PASS** — `sanitizeUpstreamError` strips URLs (path+query), Bearer tokens, key/secret assignments. Test covers API keys in URLs and Bearer headers. |
| Retry is build-step only (no double on-chain submit) | **PASS** — `fetchSwapData` produces calldata, never broadcasts. CoW order submission is client-side. |
| /api/swap returns JSON on timeout path | **PASS** — `catch` block returns `NextResponse.json({ error: sanitizeUpstreamError(...) }, { status: 502 })` |
| Velora threads abort signal | **PASS** — Both `/prices` and `/transactions` fetch calls receive `signal`. |
| `isTransientSwapError` correctly classifies | **PASS** — Timeout, network, 5xx, non-JSON → transient. Deterministic (no-route, 4xx) → not retried. |

---

## J3 — Info Tooltips (sanity) ✅

| Check | Result |
|-------|--------|
| No XSS via tooltip content | **PASS** — `content` rendered as React text child (no `dangerouslySetInnerHTML`). Test: `<img src=x onerror=alert(1)>` renders as escaped text, no `<img>` in DOM. |
| No unrelated UI change | **PASS** — Only `<span title="...">` → `<InfoTooltip content="...">` replacements in SwapBox and QuoteBreakdown. Same content strings. |
| Opens on click AND hover | **PASS** — Tests verify both paths + Escape + outside-click close. |
| Accessible | **PASS** — `role="tooltip"`, `aria-label`, `aria-expanded`, `aria-describedby`. |

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9J-I-01 | INFO | `price-gate.ts` | The consent ceiling (`PRICE_IMPACT_CONSENT_CEILING = 0.25`) is generous — 25% deviation is the largest slippage a user can "consent through." This is bounded by the user's own slippage setting (max 15% in the UI) and the on-chain `minimumOutput`, so the realized loss is always ≤ slippage. The server-side DefiLlama guard adds a further backstop. No fund-loss path. |
| 9J-I-02 | INFO | `useChainlinkPrice.ts` | The client-side hook does not explicitly check `startedAt <= 0` (incomplete round). However, incomplete rounds have `answer === 0` and `answeredInRound < roundId`, both of which trigger `oracleIntegrityFailed`. The server-side `fetchChainlinkPriceRaw` checks `startedAt <= 0` via `validateRoundData`. Defense in depth is intact. |

---

## Recommendation

**J1: APPROVED for production.** The deviation gate correctly separates oracle-integrity failures (hard-block) from price-impact deviations (informed consent). Genuine protection is preserved across all 6 mechanisms (stale feed, invalid price, stale round, extreme deviation ceiling, server-side DefiLlama, on-chain minimumOutput). The consent-escalation mechanism (review F1) and extreme-deviation ceiling (review F2) are well-designed hardening measures.

**J2: APPROVED for production.** Swap-build timeout is correct and safe (build-only, no double-submit). Error sanitization prevents key leakage.

**J3: APPROVED for production.** No XSS path. Accessible tooltip component.
