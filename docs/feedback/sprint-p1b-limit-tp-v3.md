## Feedback — SPRINT-P1B-LIMIT-TP-V3

**FULL Auditor gate required before merge (0C/0H, Opus) — fund-flow: signing + keeper execution.**

### Canonical calldata layout (why each field is deterministic)
`SwapRouter02.exactInputSingle`, selector `0x04e45aaf` — **7 fields, no `deadline`**.

| field | value | deterministic because |
|---|---|---|
| tokenIn/tokenOut | from the order | signed into the struct |
| fee | tier pinned at creation | static pick (`pickCanonicalFeeTier`, stable↔stable ⇒ 100 else 500); **never quoted** |
| recipient | the OrderExecutorV3 | contract measures its OWN delta (V3:567/:579) then forwards to owner (:592) |
| amountIn | `amountIn − amountIn*10/10000` | `FEE_BPS`/`BPS_DENOMINATOR` are `constant` (V3:131-132) and non-DCA sets `executeAmount = amountIn` (:500); BigInt division matches Solidity's floor division |
| amountOutMinimum | the SIGNED `minAmountOut` | signed; binding floor stays `max(oracleFloor, minAmountOut)` (:532-554) |
| sqrtPriceLimitX96 | 0 | constant |

**Deviation from the spec (flagged):** the spec said `deadline = order.expiry`, but SwapRouter02's
`exactInputSingle` has **no deadline field** (that's the original SwapRouter, `0x414bf389`). The time
bound is enforced on-chain by `OrderExpired` (V3:454), so the pinned calldata commits **zero clock** —
strictly better for determinism. Struct shape verified against the repo's own decoder
(`calldata-decoder.ts:86-115`). Tests pin the 224-byte body width so a deadline-carrying struct fails.

### Keeper retry/alert design
Pinned reverts do **not** enter `retry-policy.js`'s ladder (which ends in `'failed'`). A dislocated
pool at trigger is expected under option (a), so the order stays **ACTIVE** and refillable until
expiry; `alertOps({kind:'pinned-route-revert'})` fires at **5 consecutive** reverts as a *liveness*
signal (the user's order is silently not filling with its condition met). Streak clears on any fill.
Backoff reuses the existing `orderRetries`/`backoffMs` the cycle already reads. Phase-0 untouched —
pinned fills still pass `resolveSubmissionPolicy`; `order-floor.js` stays DCA-only.

### SL block evidence (3 layers)
UI toggle disabled + default flipped to `take_profit`; `handleSubmit` hard-returns; **API rejects**
`orderType==='stop_loss' && priceCondition==='below'` with `STOP_LOSS_DEFERRED_REASON`. The condition
is the only discriminator available — the contract uses `OrderType.STOP_LOSS` (enum 1) for **both** SL
and TP, so gating on `orderType` alone would have killed Take-Profit too.

### Two latent defects found and fixed
1. **`routerDataHash` was never POSTed** (`supabase.ts` omitted it) → the API rebuilt the EIP-712
   message with `body.routerDataHash ?? zeroHash` for recovery, so *any* real pinned hash would have
   400'd on "Signature mismatch". Now threaded end-to-end.
2. **Keeper hashed freshly-built calldata against the signed hash** (`executor.js` ~:1320) — a check
   that could only ever pass by luck, so no pinned order could have executed.

### Tests
11+3 builder (determinism incl. an 89-day clock jump; contract mirror; three-way
approve==signing==recipient invariant), 19 keeper (`node --test`, 200 total), 10 API, 5 page-gating.
**Full suite 2828 passed**; tsc clean; eslint back to the **exact main baseline** (20 warnings, 0
errors). Only pre-existing unrelated failure: `connect-modal-qr` (`cuer` import, present on main).

### For the Auditor's attention
- `page.test.tsx`'s "Limit/SL·TP stay removed" guard was **intentionally inverted** into 5 gating tests.
- One existing enum-encoding test used the now-refused `stop_loss`+`below` shape; split into two tests
  so both enum paths stay covered.
- The pinned-route API gate is scoped to `isV3Order` so the legacy **v2 non-DCA path is byte-identical**
  (it remains separately unexecutable — threat-model P1c — which this sprint does not change).
- `NEXT_PUBLIC_LIMIT_ENABLED` is the kill-switch; everything is fail-closed while unset.
