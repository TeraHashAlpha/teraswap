# Feedback — fix/r1-augustus-v6-group-f-decoded

**→ Auditor (#523 round 2, R1 tightening).** `0xe3ead59e`, `0x1a01c532`, `0xe37ed256` leave Group F (trusted, `extracted:null`)
for **Group I** (decoded, Group H policy via Group H's own helpers). SC-04 list, gate order, Groups A–H, R1 ≡ SC-04: unchanged. No PR.

## Evidence
1. **Layouts** — Sourcify full match `AugustusV6` (solc 0.8.22), sources byte-identical on 1/8453/42161 at routers.ts `velora`.
   Structs in `src/AugustusV6Types.sol`; selectors derived with `toFunctionSelector`, = Sourcify ABI item, PUSH4 present on all 3 chains.

   | method (file:line) | struct (fields in order) | selector |
   |---|---|---|
   | `swapExactAmountIn(address executor, GenericData, uint256 partnerAndFee, bytes permit, bytes executorData)` GenericSwapExactAmountIn.sol:31-37 | GenericData :22-30 — srcToken, destToken, fromAmount, toAmount, quotedAmount, metadata, beneficiary | `0xe3ead59e` |
   | `swapExactAmountInOnCurveV1(CurveV1Data, uint256 partnerAndFee, bytes permit)` direct/CurveV1SwapExactAmountIn.sol:40-44 | CurveV1Data :113-123 — curveData, curveAssets, + the 7 above | `0x1a01c532` |
   | `swapExactAmountInOnCurveV2(CurveV2Data, uint256 partnerAndFee, bytes permit)` direct/CurveV2SwapExactAmountIn.sol:40-44 | CurveV2Data :152-164 — curveData, i, j, poolAddress, + the 7 above | `0xe37ed256` |

   All three map beneficiary 0 → msg.sender, check received ≥ toAmount, then pay via `processSwapExactAmountInFeesAndTransfer`
   (AugustusFees.sol:70-214) — branch-for-branch the UniV3 variant (:224-367), so Group H's bound (≥ toAmount − 10 bps) carries over.
2. **Fixtures** — _pending (commit 2)._
3. **Mutations** — _pending (commit 3)._
4. **Diff / suite / lint** — _pending._ Baseline origin/main `70a6899`: 284 files / 4086 tests, lint 0 err / 94 warn.

## Feedback — Commit 1 (decode, don't trust)

### Edge case
- Group I catches its own decode failure and returns `extracted: address(0)` so `/api/v1/swap` blocks it; Group H's decode
  errors still return `extracted: null` (L-01, untouched per brief) — aligning Group H is a one-line follow-up.

### Concern
- The swap venue is response-controlled and R1 does not bound it: `swapExactAmountIn`'s `executor` receives `amountIn`
  (GenericSwapExactAmountIn.sol:71/74/79); Curve's pool is `curveData`/`poolAddress`. The only amount floor is `toAmount`,
  which R1 checks only for ≠ 0. Needs an Auditor call (executor allowlist, or toAmount vs quote).
- Augustus **V5** `simpleSwap`/`multiSwap`/`megaSwap` (SimpleData/SellData) also carry `beneficiary` and stay Group F — separate triage.
