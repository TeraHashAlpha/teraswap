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

---

## Amendment — CodeQL "user-controlled bypass" (9 HIGH)

**Headline: the 9 alerts are all false positives — but investigating them uncovered a real,
exploitable bypass that CodeQL did NOT flag.** Fixed in `94a10a2`.

### The real defect (not among the 9)
Policy gates keyed on raw request strings while the EIP-712 message derived its enums from the same
strings through a **lossy, silently-defaulting** mapping (`=== 'above' ? 0 : 1`, `... : 2`). Unknown
values fell through to BELOW/DCA instead of being refused, letting a caller desync the **policy view**
from the **signed view** by casing alone.

**Proven exploit** (verified by reverting the fix and re-running: pre-fix returned **`201 Created`**):
`{orderType:'stop_loss', priceCondition:'BELOW'}` failed the `=== 'below'` Stop-Loss gate — bypassing
the v4 deferral — while still encoding `condition = 1 (BELOW)` into the signed struct, i.e. a real,
executable on-chain stop-loss. Same class: `orderType:'DCA'` skipped the DCA interval/chunk minimums
**and the freeze circuit-breaker** while signing a genuine DCA (enum 2); an unknown `orderType` skipped
the native-ETH input gate.

**Fix / trusted invariant.** Strict total-with-rejection parsing up front (`Map` lookups, so inherited
keys like `constructor` cannot match); unknown/non-string values refused before any gate reads them. The
string→enum relation is now **bijective**, every gate branches on the **enum**, and the row persists the
**canonical label**. The SL gate **moved after signature recovery** and keys on the enums in the verified
message — so it refuses the order that would actually execute on-chain.

### Per-alert verdicts (line numbers as scanned, commit `f853d78`)
| # | Line | Guard | Verdict | Trusted invariant it rests on |
|---|---|---|---|---|
| 1–2 | 109 | `!body.signature \|\| !body.orderHash` | **FP** | ECDSA recovery == `body.wallet`; presence check only |
| 3–4 | 116 | `!body.amountIn \|\| === '0'` | **FP** | signature-bound + on-chain `MIN_ORDER_AMOUNT`/`OrderTooSmall` |
| 5–6 | 193 | `priceFeed` format | **FP** | signature-bound + on-chain `_checkPriceCondition` (staleness/round/config) |
| 7 | 350 | `body.orderType !== 'dca'` | **TRUE POSITIVE — FIXED** | now `orderTypeEnum !== ORDER_TYPE_DCA` from the strict parse |
| 8 | 353 | `!routerDataHash \|\| === zeroHash` | **FP** | `routerDataHash` is in the verified EIP-712 message; contract re-enforces `RouterDataRequired` |
| 9 | 363 | `!storedRouterData` | **FP** | precondition to `verifyRouterDataHash`, which compares unsigned bytes against the **SIGNED** hash |

Each FP carries an inline `// codeql[js/user-controlled-bypass]` naming its invariant — no blanket
dismissal.

### Tests
10 negative tests (casing variants, unknown values, non-string coercion, prototype keys, canonical
persistence, post-verification ordering). **All 8 exploit tests confirmed RED against the pre-fix code**
— they are not vacuous. Suite **2841 green**; tsc clean; eslint at the main baseline.

### ⚠️ Verification caveat for the Auditor
There is **no CodeQL CLI in this environment**, so I could not run `security-extended` locally and
**cannot myself certify "0 high"** — that must be confirmed by the CI run on this branch. Note also that
inline `// codeql[...]` suppressions are not honoured by every GitHub code-scanning configuration; if the
6 FP alerts persist after this push, they need UI dismissal citing the invariants above (the comments
document the justification either way). The **true positive at line 350 is genuinely fixed**, not
suppressed.

`sharp` untouched (separate chore), as instructed.
