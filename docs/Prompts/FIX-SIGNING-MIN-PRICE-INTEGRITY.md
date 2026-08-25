# FIX-SIGNING-MIN-PRICE-INTEGRITY — a hardcoded table may never sign an on-chain minimum

> Architect spec, committed with the implementation branch `fix/signing-min-price-integrity`
> (off `origin/main`, dedicated worktree, no PR — compare link reported).
> **Fund-flow signing path: an AUDITOR reviews this; the PR stays unmerged until 0C/0H.**
> Incident: [`Audits/Incidents/INC-2026-08-07-001.md`](../../Audits/Incidents/INC-2026-08-07-001.md)

## Context — measured, not assumed

DCA order `ef85438b` (Base 8453, cbETH → WETH, both 18 dp) signed
`minAmountOut = 5728680972022426` against `amountIn = 3186645813843290`, `dcaTotal 3`,
`maxSlippageBps 300`. Inverting `fairOut × (1 − bps/10000)` gives a USD price ratio of
**1.853314**. The contract scales per chunk (`scaledMin = minAmountOut × executeAmount / amountIn`,
`TeraSwapOrderExecutorV3.sol:526`), so the enforced floor was `1909560324007474` against quotes of
~1.202e15 — **1.588x above market, unfillable, 516 reverts** (all in simulation; keeper nonce still
14, no gas spent).

Cause: cbETH had no Chainlink and no DefiLlama price, so it fell to `APPROX_PRICES.CBETH = 3600`
while WETH priced live at ~$1942. Real cbETH that day was ~$2204. The table is stale throughout: it
says `ETH 3500`; the Base ETH/USD feed reads 1911.90 today.

## Defects

**D1 (amplifier).** In `deriveSigningMinAmountOut` (`src/lib/order-engine/v3-min-derivation.ts`):
`const source = inPick.source === 'chainlink' && outPick.source === 'chainlink' ? 'chainlink' : outPick.source`.
With in=`approx`, out=`chainlink` this reports `'chainlink'`. The ADR-013 decay warning is gated on
`source !== 'chainlink'`, so it never fired. Fix: report the **weakest** of the two tiers. `hasFeed`
must also stop claiming a real feed when a leg came from the table.

**D2 (the cause).** A hardcoded table must never price a signed on-chain minimum.
`computeReferenceExpectedOutTs`'s docblock says it "never fabricates a price" — true of the
function, false of its caller. New policy: if EITHER leg lacks both Chainlink and DefiLlama, do NOT
use `approx`; take the existing ADR-013 no-feed path (fixed non-price floor + decay warning). Keep
`APPROX_PRICES` for display and analytics; remove it from the signing inputs at the call site.

**D3 (the trap — do NOT "fix" it).** `deriveAbsoluteMinAmountOut`'s docblock demands a PER-CHUNK
amount; `DCAPanel.tsx` passes the TOTAL; the contract's `scaledMin` divides by the same factor.
They cancel. Correcting the caller alone would make every DCA minimum 3x too low — a fail-open.
Leave the behaviour unchanged; comment both ends naming the cancellation, and pin it with a test,
so nobody can break it by halves.

## Required proof — the acceptance criterion, not a nice-to-have

A regression test that, with cbETH=3600, WETH≈1942.47, `amountIn 3186645813843290` and 300 bps,
**reproduces exactly `5728680972022426`**. Then the same inputs under the new policy must return the
no-feed fallback with `hasFeed: false` and a non-chainlink `source`. If the historical number cannot
be reproduced first, stop and report: a fix that cannot recreate the bug is not shown to address it.

## Also

Investigate whether cbETH has a Chainlink feed on Base, and whether the frontend feed registry is
chain-aware for Base addresses (WETH there is `0x4200…0006`). **Report only — register nothing.**
Write an append-only incident record under `Audits/Incidents/`.

## Do NOT

- Do NOT change any Solidity. Read the contract only.
- Do NOT delete files (rule #4). Do NOT touch `.env` files, the keeper, or any database record.
- Do NOT run `ssh-add` or touch SSH/keychain material.
- Do NOT open a PR — the owner does that.

## Files

`src/lib/order-engine/v3-min-derivation.ts`, `src/components/DCAPanel.tsx`,
`src/lib/order-engine/usd.ts`, `contracts/order-engine/TeraSwapOrderExecutorV3.sol` (READ ONLY),
plus new test and incident files.

---

## Implementation record

**Acceptance gate — cleared before any code changed.** The stated WETH price of `1942.47` does not
reproduce the number (it yields `5728668747491990`, short by 12,224,530,436). Inverting the
derivation instead of assuming the input showed the window is exactly **one integer wide at both
steps**: `fairOut` must be `5905856672188069`, forcing `pOut = 194246585493`, i.e. WETH =
**$1942.46585493** and nothing else. That is a raw Chainlink 8-decimal answer, and its implied ratio
reproduces the spec's stated `1.853314` to all six decimals — so `1942.47` was a display rounding of
the real feed reading. Reproduction is therefore exact **and** uniquely pins the historical price.

- **`4fa348b` — D1 + D2 with tests.** `approxPrice{In,Out}` removed from `DeriveSigningMinParams`
  (not merely left unpassed) so the policy is compiler-enforced; `'approx'` dropped from
  `MinAmountOutSource`; tier selection replaced with an explicit `SIGNING_TIERS` ranking and a
  `weakestTier` helper; `hasFeed` true only when both legs came from a live source; both `DCAPanel`
  call sites updated. New `v3-min-price-integrity.test.ts` reproduces the historical number and
  pins the policy; the pre-existing approx-tier test — which pinned the behaviour that caused the
  incident — was rewritten.
- **`f7dd729` — D3 comments + pinning tests.** Behaviour unchanged. `amountIn` docblock rewritten to
  state the cancellation and name `TeraSwapOrderExecutorV3.sol:526`; matching notes at both
  `DCAPanel` call sites; two tests pin that signing the TOTAL then contract-scaling equals signing
  the per-chunk amount, and that the naive one-ended "fix" yields ~1/`dcaTotal` of the intended floor.
- **`e5c649f` — incident record.** `Audits/Incidents/INC-2026-08-07-001.md`, append-only.

**Verification:** 29/29 tests green across both suites; `npm run typecheck` exit 0 (the
`@ts-expect-error` pin means reintroducing `approxPriceIn` fails compilation); `npm run lint` exit 0
(94 warnings = baseline, 0 errors).

**Scope note.** D2 was implemented in the module as well as at the call site. The spec says "remove
it from the signing inputs at the call site"; removing the parameters entirely accomplishes that and
additionally makes recurrence a compile error rather than a convention. Flagged for the Auditor as
deliberately broader than the literal instruction.

**Not done, by instruction:** no feed was registered (§"Also" is report-only); findings are in the
incident record §6, including that cbETH has three live Base feeds — among them a direct
`CBETH / USD` — and that `useChainlinkPrice` only gained composed-feed resolution on 2026-07-29.
