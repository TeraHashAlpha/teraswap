# Feedback — fix/velora-selector-876a02f6-arbitrum

**→ Auditor (gate change).** Widens SC-04 by one selector and adds an R1 decode path (Group H). The owner does
not merge before 0C/0H. Gate order (SC-04 → R1 → simulation) and every existing selector are unchanged.

## Goal checklist

- [x] T1: `0x876a02f6` identified 3 independent ways, all agree (below)
- [x] T2: R1 decodes `beneficiary`; positive + negative tests on REAL Velora-adapter calldata (7bb143a)
- [x] T3: added to `swap-selectors.ts` (Velora V6.2 block, 3-way comment) + `VALIDATED_SELECTORS` + preview
- [x] Suite 283 files / 4048 tests green (baseline 4030); lint 0 err / 94 warn = origin/main `447913f` baseline
- [x] SSH-signed commits, pushed, compare link reported (no PR)

## Result

- **Method:** `swapExactAmountInOnUniswapV3(UniswapV3Data uniData, uint256 partnerAndFee, bytes permit)`,
  `UniswapV3Data { srcToken, destToken, fromAmount, toAmount, quotedAmount, metadata, beneficiary, pools }`.
- **Beneficiary:** tuple field [6] of arg 0 → calldata byte 292 (0x124) in the canonical layout (arg-0 offset
  0x60). Only output destination: pool legs pay `address()`, pools are CREATE2-derived. On-chain `address(0)`
  becomes `msg.sender`, which calldata cannot prove, so R1 rejects a zero beneficiary.
- **(a) derivation:** viem `toFunctionSelector(sig)` → `0x876a02f6`; controls 0xe3ead59e/0x1a01c532/0xe37ed256 reproduce.
- **(b) on-chain:** `eth_getCode` on 42161 at routers.ts `42161.velora` → 24,562 B; PUSH4 `0x876a02f6` PRESENT
  (3 controls present, 0xdeadbeef absent). Sourcify full match `AugustusV6` (solc 0.8.22); its ABI item derives the same selector.
- **(c) signature DBs:** openchain.xyz and 4byte.directory (id 1130781) → the same signature.
- **Fixture:** unmodified `velora.ts` `fetchSwapData` against Velora `/transactions/42161` (ignoreChecks, nothing
  signed/sent), 0.01 WETH→USDC. Velora picked the method unforced; beneficiary = requested receiver in both shapes.
- **Tests:** `calldata-recipient` `[Group H]`: derived = keeper-log · captures target whitelisted Augustus ·
  DIRECT valid · FEE-ROUTED valid · NEG fee-routed vs `from` · NEG foreign beneficiary (one-word edit) · NEG zero
  beneficiary · NEG truncated · FeeCollector policy · NEG foreign inside multicall · siblings stay Group F; plus
  `contains exactly 24` · `Group H entry is derived`. `swap-selectors` `[R1 Group H]`: derived · allowed ·
  siblings stay blocked · arbitrary 4-byte unknown. `calldata-decoder` `[Group H]`: extracted preview · truncated.
- **User gain:** Arbitrum Velora routes that settle through a single Uniswap V3 pool (e.g. WETH→USDC, the DCA
  pair) 400'd at SC-04 whenever Velora quoted best, so they were lost. The 2026-09-14 keeper fill slipped from 17:33 to 17:36 via another source.

## Feedback — (7bb143a, T3 commit)

### Assumption that turned out wrong
- R1 did NOT locate a recipient for `0xe3ead59e` or the two Curve selectors: they are Group F trust-only
  (`implicitRecipient`). Group H is stricter than its siblings; the siblings are untouched.
- `docs/Prompts/SPRINT-9H*.md` does not exist (9G → 9I). The precedent exists only in code comments and tests.

### Concern
- `/api/v1/swap` runs no SC-04 and lets an unextracted R1 failure through. Group H sets `extracted` on every rejection, so v1 blocks it. *(Wrong for decode errors — see Audit round 1, L-01.)*
- R1 does not check `partnerAndFee` (true of every Augustus selector). Augustus applies that fee AFTER its
  `toAmount` check (verified source), so the backstop is the executor/FeeCollector balance-delta check. Worth an Auditor look. *(Now checked for Group H — Audit round 1, rule (a).)*

## Audit round 1 — fixes (8273f48 · 8f3031c · this commit)

**Brief premise corrected → rule (a) is structured, not literal (owner decision, 2026-09-25).** Both REAL captures carry
`partnerAndFee = 0x45a6e007c874ffc6321d6fb90eac272dd6864bfa100000000000000000000001`: partner `0x45a6…4bfa` (= word >> 96,
the HIGH 160 bits, AugustusFees.sol:720-731), 1 bps, IS_CAP_SURPLUS (bit 92). Velora injects it; `velora.ts` sends no partner.

- **H-01 / M-01 (8273f48):** zero beneficiary → (a) partner ∈ {0, `VELORA_DEFAULT_PARTNER`}, fee ≤ 10 bps, no feeData bit
  outside fee|IS_CAP_SURPLUS → (b) quotedAmount ≥ toAmount → (c) toAmount ≠ 0 → recipient match. Every rejection sets
  `extracted`; (a)'s reason logs the word in hex. Worst case now: beneficiary ≥ toAmount − 10 bps.
- **L-02 (this commit):** a zero beneficiary previews as `recipientType: 'invalid'`, `validated: false`; toAmount carries
  `amountOutMinLabel: 'router minimum (before router fees)'`.
- **L-01 (correction):** decode errors (truncated calldata, alone or inside a multicall) return `extracted: null`
  (calldata-recipient.ts:1003-1008), and v1 blocks only on `!valid && extracted` (route.ts:524), so it logs and proceeds.
  Pre-existing for every group, ends in an on-chain revert, out of scope; v1 unchanged.

### Concern
- `VELORA_DEFAULT_PARTNER` is derived from the DIRECT fixture at module load, as specified: the first production import of
  a `__fixtures__` file. If Velora rotates its partner, those routes fail closed (400): availability, not funds.
- The UI hard-codes "Minimum output" (TransactionPreview.tsx:211/218, SplitReviewModal.tsx:102); rendering
  `amountOutMinLabel` there is a one-line follow-up outside this diff. (c) is defence in depth: the router already reverts
  `InvalidToAmount` (UniswapV3SwapExactAmountIn.sol:54).

### Evidence
1. Commit 1, rule hunk, comment and blank lines trimmed (`git show 8273f48` for the rest):
```diff
@@ -768,16 +851,36 @@ function decodeAugustusUniswapV3Recipient(
+  const feeViolation = augustusPartnerAndFeeViolation(partnerAndFee)
+  if (feeViolation) {
+    return rejectAugustusUniV3(
+      beneficiary,
+      `partnerAndFee ${toHex(partnerAndFee, { size: 32 })}: ${feeViolation}; fees are applied after toAmount`,
+    )
+  }
+  if (uniData.quotedAmount < uniData.toAmount) {
+    return rejectAugustusUniV3(
+      beneficiary,
+      `quotedAmount ${uniData.quotedAmount} < toAmount ${uniData.toAmount}: quotedAmount below toAmount enables surplus capture`,
+    )
+  }
+  if (uniData.toAmount === 0n) {
+    return rejectAugustusUniV3(beneficiary, 'toAmount 0: zero toAmount disables Augustus output check')
```
2. **38 new, 38/38 pass.** `calldata-recipient` `[Group H] Augustus fee fields` (36): NEG (a) IS_USER_SURPLUS · IS_DIRECT_TRANSFER ·
   IS_SKIP_BLACKLIST · IS_REFERRAL · IS_TAKE_SURPLUS; and ×DIRECT/FEE-ROUTED: fee 11 bps · fee 0x3FFF · unread bit 89 · unread
   bit 14 · attacker partner + 1 bps/CAP · attacker + TAKE_SURPLUS · attacker in low 160 bits; NEG (b) quotedAmount = 1 ·
   = toAmount − 1; NEG (c) toAmount = 0; H-01 as run; check order. POS both captures unmodified; ×2: word 0 · right partner
   at 10 bps · partnerAndFee = 1 (partner 0); quotedAmount == toAmount. Pins: partner = both captures' · each word exact.
   `calldata-decoder` (2): [L-02] zero beneficiary → invalid · toAmount label. Mutants (one rule off at a time) fail:
   (a) 20 · (b) 3 · (c) 2 · fee cap 4 · flag bits 9 · partner 7.
3. `git diff --stat b3f9e38`:
```
 docs/feedback/fix-velora-selector-876a02f6-arbitrum.md |  65 ++++++++++++-
 src/lib/calldata-decoder.test.ts                       |  23 ++++-
 src/lib/calldata-decoder.ts                            |  26 ++++-
 src/lib/calldata-recipient.test.ts                     | 240 +++++++++++++++++++++++++++++++++++++++++++++++
 src/lib/calldata-recipient.ts                          | 131 +++++++++++++++++++++++---
 5 files changed, 464 insertions(+), 21 deletions(-)
```
4. Suite 283 files / **4086** vs origin/main `447913f` 283 / 4030 (+56: 18 earlier on this branch, 38 here). Lint 0 err /
   94 warn on both, identical warning set (file × rule) → **delta 0**. `tsc --noEmit` clean.
