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
- `/api/v1/swap` runs no SC-04 and lets an unextracted R1 failure through. Group H sets `extracted` on every rejection, so v1 blocks it.
- R1 does not check `partnerAndFee` (true of every Augustus selector). Augustus applies that fee AFTER its
  `toAmount` check (verified source), so the backstop is the executor/FeeCollector balance-delta check. Worth an Auditor look.
