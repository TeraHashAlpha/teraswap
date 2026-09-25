# Feedback — fix/r1-augustus-v6-group-f-decoded

**→ Auditor (#523 round 2, R1 tightening).** `0xe3ead59e`, `0x1a01c532`, `0xe37ed256` leave Group F (trusted, `extracted:null`) for
**Group I** (decoded; Group H policy via Group H's own helpers). SC-04 list, gate order, Groups A–H, R1 ≡ SC-04: unchanged. No PR.

## Evidence
1. **Layouts** — Sourcify full match `AugustusV6` (solc 0.8.22), identical sources on 1/8453/42161 at routers.ts `velora`. Selectors
   derived (`toFunctionSelector`) = Sourcify ABI item = PUSH4 in deployed code on all 3 chains. Structs in `src/AugustusV6Types.sol`.

   | method (file:line) | struct :lines — fields in order | selector |
   |---|---|---|
   | `swapExactAmountIn(address executor, GenericData, uint256 partnerAndFee, bytes permit, bytes executorData)` GenericSwapExactAmountIn.sol:31-37 | GenericData :22-30 — srcToken, destToken, fromAmount, toAmount, quotedAmount, metadata, beneficiary | `0xe3ead59e` |
   | `swapExactAmountInOnCurveV1(CurveV1Data, uint256 partnerAndFee, bytes permit)` direct/CurveV1SwapExactAmountIn.sol:40-44 | CurveV1Data :113-123 — curveData, curveAssets, + the 7 above | `0x1a01c532` |
   | `swapExactAmountInOnCurveV2(CurveV2Data, uint256 partnerAndFee, bytes permit)` direct/CurveV2SwapExactAmountIn.sol:40-44 | CurveV2Data :152-164 — curveData, i, j, poolAddress, + the 7 above | `0xe37ed256` |

   All three: beneficiary 0 → msg.sender, revert if received < toAmount, then pay via `processSwapExactAmountInFeesAndTransfer`
   (AugustusFees.sol:70-214), branch-for-branch the UniV3 variant (:224-367) — so Group H's bound (≥ toAmount − 10 bps) holds.
2. **Fixtures — 6/6 CAPTURED, 0 SYNTHETIC** (`__fixtures__/velora-augustus-v62-exact-in-mainnet.ts`, **mainnet**): unmodified
   `fetchSwapData` → Velora `/transactions/1` (nothing signed/sent), DIRECT + FEE-ROUTED, verbatim `tx.data`, `tx.to` = routers.ts `1.velora`.
   Forced via `includeContractMethods` on the adapter's `/prices` URL; Curve also needed `includeDEXS` (else `400 "No contract method
   available…"`). Generic WETH→USDC · CurveV1 USDC→USDT (3pool) · CurveV2 WETH→USDT (tricrypto2). All 6: beneficiary = receiver, Group H word.
3. **Mutations** — both captures each, re-encoded via the exported ARG_TYPES; from a live run, rows merged only where every cell
   matches. Each ✗ is `valid:false` with `extracted` set ⇒ `/api/v1/swap` blocks too (asserted per test); (a) reasons carry the hex word.

   | mutation | Generic | CurveV1 | CurveV2 | `extracted` |
   |---|---|---|---|---|
   | capture unmodified · partnerAndFee = 0 | ✓ | ✓ | ✓ | taker / user |
   | attacker beneficiary · same inside `multicall` | ✗ recipient | ✗ recipient | ✗ recipient | attacker |
   | TAKE_SURPLUS + quoted = 1 · 0x3FFF bps · attacker partner 1 bps · Velora 11 bps · bit 89 | ✗ (a) | ✗ (a) | ✗ (a) | taker / user |
   | quotedAmount = toAmount − 1 · toAmount = 0 | ✗ (b) · (c) | ✗ (b) · (c) | ✗ (b) · (c) | taker / user |
   | zero beneficiary · truncated to 200 B · last word cut | ✗ zero · decode | ✗ zero · decode | ✗ zero · decode | `0x0` |

   Mutants on the committed source → failing tests: re-trust 94 · drop (a) 36 · (b) 9 · (c) 9 · zero check 9 · decode→`null` 13.
   Preview: `extracted` + "router minimum (before router fees)"; zero beneficiary or undecodable → `invalid`.
4. `git diff --stat origin/main` (`70a6899`):
   ```
   docs/feedback/fix-r1-augustus-v6-group-f-decoded.md          |  53 +++++++++
   src/lib/__fixtures__/velora-augustus-v62-exact-in-mainnet.ts | 219 +++++++++++++++++++++++++++++++++++++
   src/lib/calldata-decoder.test.ts                             |  61 ++++++++++-
   src/lib/calldata-decoder.ts                                  |  51 ++++++++-
   src/lib/calldata-recipient.test.ts                           | 298 ++++++++++++++++++++++++++++++++++++++++++++++++++-
   src/lib/calldata-recipient.ts                                | 280 ++++++++++++++++++++++++++++++++++++++++++++---
   6 files changed, 938 insertions(+), 24 deletions(-)
   ```
   Suite 284 files / **4194** vs origin/main 284 / 4086 (**+108**); `tsc` clean. Lint 0 err / 94 warn on both, identical set → **delta 0**.

## Feedback — 58adfda (decode) · f75ea43 (fixtures) · tests
### Edge case
- Group I catches its own decode failure → `extracted: 0x0` (v1 blocks); Group H's still return `null` (L-01, untouched) — one-line follow-up.
### Concern
- The venue is response-controlled and R1 does not bound it: `swapExactAmountIn`'s `executor` receives `amountIn`
  (GenericSwapExactAmountIn.sol:71/74/79); Curve's pool is `curveData`/`poolAddress`. Only floor: `toAmount` (R1: ≠ 0). Auditor call.
- Augustus **V5** `simpleSwap`/`multiSwap`/`megaSwap` (SimpleData/SellData) also carry `beneficiary`; still Group F — separate triage.
