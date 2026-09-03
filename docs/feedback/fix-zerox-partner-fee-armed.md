## Feedback — fix/zerox-partner-fee-armed

### Verdict: arming is SAFE — but read the calibration gap before trusting it

Arming `validateFeeIntegrity` for the native partner-fee sources blocks **no**
legitimate swap. Evidence below. The finding that matters more is that the check,
at its current tolerance, **cannot detect the failure it is named for**.

#### The tolerance (`src/lib/api.ts` `validateFeeIntegrity`)

```
tolerance = quoted * 2 / 100          // 2% of the QUOTED output
invalid  ⟺ swapped > quoted + tolerance
```

**One-sided.** There is no floor — a swap output *below* the quote never fails,
at any distance (an output of `0` passes). Only an implausibly HIGH output blocks.
Boundary measured in both directions (`src/lib/fee-integrity-armed.test.ts`), on
`quoted = 1_000_000_000`:

| swapped | result | why |
| --- | --- | --- |
| `1_019_999_999` | valid | below ceiling |
| `1_020_000_000` | **valid** | exactly at ceiling — comparison is `>`, not `>=` |
| `1_020_000_001` | **invalid** | one unit over → blocks |
| `0` | valid | no lower boundary exists |

#### Why arming cannot false-positive, per source

- **`0x`** — `applyPartnerFee` (zerox.ts:22-27) is called on **both** the `/price`
  quote and the `/quote` build, so both amounts are already post-fee and differ
  only by routing drift between two 0x calls seconds apart. Tripping needs >2%
  drift. Tested valid at +0.30%, +1.00%, +1.99%, and at −0.5%/−5%/−50%.
- **`cowswap`** — inert by construction: `validateFeeIntegrity`'s own
  `skipSources` already hard-skips `'cowswap'` (solver surplus is not a
  deduction, so a higher fill is normal). Listing it changes nothing at the
  validator.
- **`bebop`** — armed but *structurally untrippable*: bebop.ts keeps the price
  quote **GROSS** and puts `fee`/`fee_recipient` on the firm quote only, so
  `swapped ≤ quoted` always. (Also still in `DISABLED_SOURCES` — no vendor key.)

### Concern — CALIBRATION GAP (the headline finding)

The tolerance is **2%**; `FEE_BPS` is **10 (0.1%)** — a ~20× margin. If 0x honoured
`swapFeeBps` on `/price` and silently dropped it on `/quote`, the build output
would rise by `1/(1-0.001) - 1 ≈ 0.1001%`, which sits **~20× inside** the band and
**passes**. Detection would require the fee itself to exceed 2%, i.e. `FEE_BPS > 200`.

So the armed check is an **anomaly tripwire** (it does catch a 5× output, a
wrong-token route), **not** evidence the fee was collected. It should not be cited
as fee assurance. Arming still strictly dominates leaving it inert — it costs
nothing and closes the gross-anomaly hole — but the guarantee is weaker than the
error message ("the partner fee was not applied") implies.

Proposed follow-up (separate fund-flow task, deliberately NOT done here): assert
the fee **out of band** rather than by amount-differencing — 0x v2's swap response
carries an integrator-fee object (`fees.integratorFee` per the v2 docs —
**UNVERIFIED here, this session has no 0x API key and did not call their API**);
asserting it is present, denominated in the expected token and equal to `FEE_BPS`
would be a real detector. That touches the adapter, so it was out of scope.

### Concern — scope: three sources were added, not one

The goal said "add `'0x'`". The invariant it also stated — *a source is fee-native
iff its adapter attaches partner-fee params* — is bidirectional, and `cow.ts:117`
(`metadata.partnerFee`) and `bebop.ts:125-126` (`fee` + `fee_recipient`) attach
them too. The drift test measures the **wire**, so listing only `'0x'` would have
left it failing, and an exemption list for the other two would reintroduce exactly
the drift the test exists to prevent. Both additions are shown above to be
unable to block a swap. `FEE_INCOMPATIBLE_SOURCES` is untouched.

### Three-way fee-mode table after this change (`src/lib/fee-mode.ts`)

| Source | Mode (mainnet) | Fee actually taken by | M-01 check | Mode on a chain with no FeeCollector |
| --- | --- | --- | --- | --- |
| `0x` | `native-partner-fee` | 0x API — `swapFeeBps` → `FEE_RECIPIENT` | **RUNS** (2% ceiling) | `native-partner-fee` |
| `cowswap` | `native-partner-fee` | CoW appData `metadata.partnerFee` | runs, hard-skipped inside | `native-partner-fee` |
| `bebop` | `native-partner-fee` | Bebop JAM `fee`/`fee_recipient` (firm quote) | runs, untrippable | `native-partner-fee` |
| `1inch`, `kyberswap`, `velora`, `uniswapv3`, `sushiswap`, `curve`, `openocean` | `fee-collector` | TeraSwapFeeCollector V2, on-chain | skipped (correct — fee is enforced on-chain) | **`none`** |
| `balancer`, `odos` | n/a — `DISABLED_SOURCES` | — | — | — |

Mode is a *classification of mechanism*, not a liveness claim: `bebop` classifies
as native while disabled, exactly as `odos` would.

### Edge case — a user-visible change on non-mainnet chains

`QuoteBreakdown.tsx:109` called `isFeeCollectorActive()` with **no `chainId`**, so it
answered for mainnet on every chain even though the component already receives
`chainId`. `feeMode(source, chainId)` fixes that. Consequence: on a chain whose
`feeCollector` is env-null (Base and Arbitrum today, `registry.ts:76`/`:124`) a
FeeCollector-routed source now renders "Free" instead of a 0.1% fee. That is the
truthful answer — there is no FeeCollector deployed there to take a fee — and such
a chain is `coming-soon` (`activation.ts:27`, `isChainActive === false`), so swaps
are not live on it. Blast radius is the quote-comparison display on a chain that
cannot swap. Flagged because it is a behaviour change the goal did not ask for.

### Edge case — the two call sites of `validateFeeIntegrity` disagree (pre-existing)

`useSwap.ts:437` gates on `FEE_NATIVE_SOURCES`; `useSplitSwap.ts:317` calls it for
**every** leg with no gate at all. So the check was never fully inert — split legs
have always run it for all non-skip sources, including FeeCollector-routed ones
that `useSwap`'s own comment says would false-positive. In practice it is harmless
(FeeCollector routing makes the swap output *lower*, and the check is one-sided),
but the two sites encode different beliefs. Not changed here — out of scope, and
changing the split path is a fund-flow edit of its own.

### Edge case — a test was pinning the drift in place

`swap-validations.test.ts` asserted `expect(FEE_NATIVE_SOURCES).toEqual([])` and
called it "the current production reality". It had stopped being true when
SPRINT-9T shipped the adapter params; the assertion actively protected the stale
value. Replaced with the derived membership plus a call-site test for `'0x'`.

### Test gap — marker-list detection is curated, not exhaustive

`partner-fee-drift.test.ts` detects fee params by a curated list of vendor
parameter names (`swapFeeBps`, `partnerFee`, `fee_recipient`,
`buyTokenPercentageFee`, `referrerAddress`, …). A future vendor inventing a name
outside that list would not be caught, so **adding an integration means adding its
marker**. Deliberately NOT "any param whose value equals `FEE_RECIPIENT`": CoW
sends `metadata.referrer.address = FEE_RECIPIENT` on the fee-FREE appData too, and
a referrer tag collects nothing — that rule would have produced a false positive.

### Proposed honest wording (NOT applied — copy left untouched, as instructed)

`QuoteBreakdown.tsx:493` today:

- fee branch: *"This fee supports platform development. Collected by the aggregator API."*
- no-fee branch: *"No fee for this route. Fees are collected on 1inch, 0x, and KyberSwap routes."*

Both are inaccurate now. (1) "Collected by the aggregator API" describes the
**native** mechanism but is shown for every source — for 1inch/KyberSwap the fee is
taken on-chain by the FeeCollector, not by the aggregator. (2) The no-fee branch
names `0x` as a fee route while sitting in the branch that says no fee is charged,
and `0x` is now precisely a fee-charging route; the three-source list is stale
(seven sources route via the FeeCollector). Suggested, one per mechanism:

- `native-partner-fee`: "The 0.1% platform fee is collected by {source}'s own API and paid directly to TeraSwap — no extra contract hop."
- `fee-collector`: "The 0.1% platform fee is collected on-chain by the TeraSwap FeeCollector contract as part of your swap."
- `none`: "No platform fee on this route — TeraSwap's fee contract isn't deployed on this chain yet."

### Acceptance results

1. **PASS** — `FEE_NATIVE_SOURCES` contains `'0x'`. Negative control run for real:
   `src/lib/constants.ts` reverted to `origin/main` → the drift test fails 3/6 with
   `0x sends 'swapFeeBps' but is MISSING from FEE_NATIVE_SOURCES` (plus `bebop`
   `fee_recipient`, `cowswap` `partnerFee`); restored → 6/6. A list-independent
   negative control is also pinned inside the test file so CI keeps it honest.
2. **PASS** — the check runs for a 0x swap (`ran: true`, driven by the real
   constant) and passes on realistic pairs; both boundary cases behave as
   documented in the table above.
3. **PASS** — `feeCollected` for `'0x'` is true via `native-partner-fee`, and stays
   true on a chain where the FeeCollector is inactive, while `kyberswap` on that
   same chain drops to `none` — isolating the two previously OR-ed terms. Asserted
   both at the classifier and in the DOM (`data-fee-mode`).
4. **PASS** — full suite **258 files / 3663 tests, 0 failures**; `tsc --noEmit`
   clean; lint **94 warnings, 0 errors** (the repo's existing ceiling — the four new
   files add none).

### For the Auditor — attack this first

**The calibration, not the arming:** this branch turns on a guard whose 2% tolerance
is ~20× the 0.1% fee it is meant to protect, so a green fee-integrity check is now
easy to mistake for proof the fee was collected when it cannot detect a dropped fee at all.
