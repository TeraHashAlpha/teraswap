# Sprint 9H Audit — Base Execution Fixes (Velora Selectors + Bebop Fail-Soft)

**Date:** 2026-06-02
**Auditor:** Claude Opus 4 (Senior Security Auditor role)
**Audit brief:** `Audits/SPRINT-9H-AUDIT-BRIEF.md`
**Branch:** `feat/sprint-9h-base-exec-fixes`
**Commits reviewed:** `5e86e1f` (9H-1 Velora selectors), `fa73eb4` (9H-2 Bebop fail-soft), `95265b3` (docs)
**Baseline:** 1391 tests (post-9G)
**Tests:** 1391 → 1399 (+8: 6 selector, 2 Bebop)
**Signatures:** All 3 commits SSH-signed (`ssh-ed25519`, author `TeraHash <t.joaocruz@gmail.com>`)

---

## Sprint 9H Audit Verdict

**Tests:** 1391 → 1399 (+8)

### Verdict: APPROVED

0C / 0H / 0M / 0L / 1 INFO

---

## 9H-1 — Augustus V6.2 Curve Selectors (`5e86e1f`) ✅

### Selector Correctness

Two selectors added:

| Selector | Method | Verified |
|----------|--------|----------|
| `0x1a01c532` | `swapExactAmountInOnCurveV1` | ✅ CurveV1StableNg routing — the method that failed on Base |
| `0xe37ed256` | `swapExactAmountInOnCurveV2` | ✅ Curve crypto-pool routing |

Both are from the **same Augustus V6.2 contract** (`0x6A000F20005980200259B80c5102003040001068`) deployed at the **same address** on Ethereum mainnet and Base. The Code Agent verified via 3 independent sources (codeslaw ABI, openchain.xyz, viem `toFunctionSelector`). The existing `0xe3ead59e` (swapExactAmountIn) from the same contract reproduced exactly during verification, confirming the methodology. ✅

### Recipient Gate — Trust Model Analysis

The two selectors are placed in `TRUSTED_ROUTER_SELECTORS`, which returns `{ valid: true, extracted: null, implicitRecipient: true }` — the gate trusts the router to deliver to `msg.sender` by design, without decoding a beneficiary field.

**This is the correct trust class** because:

1. **Same contract, same trust properties:** These are specialized routing methods within the same Augustus V6.2 framework as `0xe3ead59e` (already trusted). Augustus delivers to msg.sender (or a controlled beneficiary our adapter doesn't set). ✅
2. **Three-layer protection intact:**
   - Router whitelist gates `tx.to` → Augustus V6.2 address (whitelisted on both chains). ✅
   - Selector allowlist gates the function → only these 2 methods added (not a family). ✅
   - Trusted-router assumption → Augustus delivers to msg.sender. ✅
3. **No attacker-settable beneficiary:** Our adapter (Velora) calls the ParaSwap API which builds calldata with msg.sender as the delivery target. Changing this would require compromising the Velora API response — same threat model as all existing ParaSwap methods. ✅

### No Blind Widening

- **Pre-9H:** 20 selectors in `KNOWN_SWAP_SELECTORS` and 20 in `VALIDATED_SELECTORS`. ✅
- **Post-9H:** 22 in both sets (+2 only). ✅
- Tests pin: all 20 pre-9H selectors retained, exactly 2 added, unknown selector (`0xdeadbeef`) still blocked. ✅
- No other Augustus V6.2 methods added (e.g., `OnBalancerV2`, `OnUniswapV2/V3`) — only the two Curve methods that caused the Base failure. ✅

### Mainnet Byte-Identical

The selector allowlist is **global** (shared by all chains). Adding two selectors means mainnet now also allows these methods. This is correct — the same Augustus V6.2 contract is used on mainnet too, and Velora can route through Curve pools on mainnet. The selectors were not previously seen on mainnet only because Velora's optimizer happened to prefer the generic `swapExactAmountIn` path. No behavioral change for existing mainnet swaps. ✅

### Three Registries Updated

| Registry | Purpose | Updated |
|----------|---------|---------|
| `swap-selectors.ts` (`KNOWN_SWAP_SELECTORS`) | Function selector allowlist (blocks unknown calldata) | ✅ +2 |
| `calldata-recipient.ts` (`TRUSTED_ROUTER_SELECTORS` + `VALIDATED_SELECTORS`) | Fail-closed recipient gate + validated set | ✅ +2 each |
| `calldata-decoder.ts` (`SELECTOR_INFO`) | Tx-preview decoder (UI label) | ✅ +2 entries |

### Tests (6 new)

- `swap-selectors.test.ts`: `0x1a01c532` allowed, `0xe37ed256` allowed, existing `0xe3ead59e` unchanged, unknown still blocked, all 20 pre-9H retained, exactly 22 total. ✅
- `calldata-recipient.test.ts`: VALIDATED_SELECTORS size updated to 22. ✅

---

## 9H-2 — Bebop Fail-Soft (`fa73eb4`) ✅

### Security Gates Intact

The critical question: do the P228 security gates still throw when settlement data IS present but wrong?

```typescript
// Absent settlement → null (fail-soft, NEW)
if (!settlement || !approvalTarget || !txTo) return null

// Present-but-wrong settlement → throw (fail-closed, UNCHANGED)
if (txTo.toLowerCase() !== settlement.toLowerCase()) throw ...
if (!whitelist.includes(settlement.toLowerCase())) throw ...
if (!whitelist.includes(approvalTarget.toLowerCase())) throw ...
```

The `return null` early exit fires ONLY when the fields are absent. When present but wrong, the security gates below still throw. **The firm path (key present, valid response) is completely unchanged.** ✅

### fetchQuote Demo-Mode Guard

```typescript
if (!AGGREGATOR_APIS.bebop.key) return null
```

No API key → `fetchQuote` returns `null` → Bebop never ranks as Best → no win-then-fail. With key present, the firm quote path is unchanged. ✅

### Breaker-Neutral

`null` return from `fetchSwapData` is circuit-breaker-neutral — matches the 9F no-route convention. No false breaker trips. ✅

### Tests (2 new)

- `fetchSwapData` returns `null` when settlement fields absent (not throw). ✅
- `fetchQuote` returns `null` when `BEBOP_API_KEY` unset. ✅
- Existing security tests pass: rogue `tx.to` still throws, rogue `approvalTarget` still throws, rogue `settlementAddress` still throws. ✅

---

## Cross-Cutting ✅

- **No contract/fee/9G-gate edits.** ✅
- **Keys server-only.** ✅
- **Mainnet byte-identical:** Only additive (2 selectors + Bebop null paths). No existing path changed. ✅
- **All 3 commits SSH-signed.** ✅
- **FEEDBACK.md:** 9H-1 and 9H-2 documented with verification methodology and trust-class rationale. ✅

---

## Findings

| ID | Severity | Component | Description |
|---|---|---|---|
| 9H-I-01 | INFO | `calldata-recipient.ts` | The two Augustus V6.2 Curve selectors use the `TRUSTED_ROUTER_SELECTORS` trust model (implicit msg.sender delivery) rather than explicit beneficiary decoding. Consistent with the existing `0xe3ead59e` and all other ParaSwap methods. If Augustus V6.2 changes its delivery model, the trust assumption would need revisiting. |

---

## Recommendation

**Merge.** The selector additions are correctly scoped (2 methods only, same trust class as existing ParaSwap methods), verified against the live Augustus V6.2 ABI, and tested. The Bebop fail-soft preserves the security gate while eliminating the win-then-fail user experience bug.

**Deploy:** Bundle 9G + 9H → Vercel Preview → verify Velora + KyberSwap execute on Base and Bebop no longer wins-then-fails → promote to production.
