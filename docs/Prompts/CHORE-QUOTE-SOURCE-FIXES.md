# CHORE-QUOTE-SOURCE-FIXES — OpenOcean units bug + Balancer dead adapter

> **Source:** T-SAF W7-L-02 coverage-check report (2026-07-02). Two source-adapter defects that corrupt the
> **displayed** best quote (execution stays safe — SC-04 → 9O fallback + on-chain `minimumOutput` backstop — but the
> user can be shown a false price). **Display/observability only. No contract change, no SC-04/on-chain whitelist
> change, no deploy.** SSH-signed (noreply committer). Two independent commits so either can be dropped.

## Context
The coverage check that closed W7-L-02 (Curve/Balancer/OpenOcean add ~0 unique executable liquidity — leave them
quote-only, no decoders) surfaced two real defects in those adapters:
1. **OpenOcean sends raw base units to an API that expects human amounts** (`openocean.ts:~11` passes `amount`
   unconverted) → the returned quote is 10^decimals too large (10^6–10^18×). When **exactly 2** sources respond, the
   quote-selection outlier filter (3×-median / 1.5×max) mathematically cannot trigger, so the **garbage quote wins the
   displayed "best price"**. (In monitor history this is the *entire* origin of OpenOcean's fake "78.8% win rate".)
2. **Balancer's adapter is dead:** `api-v3.balancer.fi/order/{chainId}` returns **404** ("only /, /graphql and /log
   allowed"). The adapter has produced **0 prod quotes ever**; it only ever contributes errors/nulls.

## Objective
OpenOcean either quotes correctly or is disabled; Balancer is marked dead and excluded from quote selection — so no
source can inject a mis-scaled or null value into the displayed winner. No change to execution gates or fund flow.

## Requirements (two independent commits)

### Commit 1 — OpenOcean units (`openocean.ts`)
- Fix the request so the sell amount is sent in the **human unit the OpenOcean API expects** (decimals-adjusted:
  `amount / 10^sellToken.decimals`, per their API contract — verify against their docs), and convert the returned
  buy amount **back to base units** for internal consistency with the other adapters.
- Add a unit test with two known-decimals pairs (e.g. **USDC 6-dec → WETH 18-dec** and **WETH → USDC**) asserting the
  normalized quote lands within a sane band of a reference quote (not 10^n off).
- **Decision to record in FEEDBACK:** the one-line units fix is **preferred** (keeps quorum breadth — more correct
  responders make the outlier filter more robust). If, on inspection, the OpenOcean integration is too brittle to
  trust, the fallback is to add it to `DISABLED_SOURCES` instead. Pick one, justify it in FEEDBACK.

### Commit 2 — Balancer dead → disabled (`balancer.ts`)
- Add Balancer to `DISABLED_SOURCES` (per chain) so it is **not called** and **does not count toward quorum**.
- Mark the adapter **superseded** in-file (header comment — rule #4, do **not** delete the file): note the v2 order
  endpoint is 404 and that re-enabling requires migrating to the **Balancer v3 GraphQL SOR** endpoint.
- Confirm no code path treats a disabled/erroring source as a `0`/null candidate in winner selection.

## Do NOT
- No contract change; do **not** touch the SC-04 `isKnownSwapSelector` allowlist or any on-chain router whitelist.
- Do **not** delete the Balancer file (mark superseded). Do **not** change other adapters' fail-soft behavior.
- Do **not** alter the execution/settlement path — this is display/quote-selection hygiene only.

## Files affected (verify on main)
- The OpenOcean adapter (`openocean.ts`, the ~line-11 request build) + its test.
- The Balancer adapter (`balancer.ts`) + the `DISABLED_SOURCES` config.

## Expected output
- Branch `chore/quote-source-fixes` off latest `origin/main`; SSH-signed; CI green. Two commits (OpenOcean; Balancer).
  Tests: OpenOcean normalized quote is sane-banded (not 10^n off); Balancer excluded from quorum. FEEDBACK records the
  OpenOcean fix-vs-disable decision and the Balancer v3-SOR re-enable path.

## Quality criteria
No source emits a mis-scaled quote into the displayed winner; a dead endpoint contributes nothing to quorum; zero
contract / SC-04 / on-chain-whitelist / execution-path change; displayed-price integrity restored for low-quorum windows.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-QUOTE-SOURCE-FIXES per docs/Prompts/CHORE-QUOTE-SOURCE-FIXES.md. Branch off
origin/main, SSH-signed (noreply committer), CI green, TWO independent commits.
Display/quote-selection hygiene ONLY — no contract change, no SC-04 allowlist or
on-chain whitelist change, no deploy, no execution-path change.

Source: T-SAF W7-L-02 coverage check (2026-07-02). Two adapter defects corrupt the
DISPLAYED best quote (execution is backstopped by SC-04->9O fallback + on-chain
minimumOutput, so no fund risk — but the user can be shown a false price).

Commit 1 — OpenOcean units (openocean.ts ~:11): it sends the sell amount in RAW
base units to an API that expects HUMAN amounts -> quote is 10^decimals too large
(10^6-10^18x). In exactly-2-responder windows the 3x-median/1.5x-max outlier
filter can't trigger, so the garbage quote WINS the displayed best price (this is
the entire source of OpenOcean's fake ~78.8% "win rate"). FIX: send amount as
amount/10^sellToken.decimals (verify vs OpenOcean API docs) and convert the
returned buy amount back to base units for internal consistency. Add a unit test
(USDC 6dec->WETH 18dec and WETH->USDC) asserting the normalized quote is within a
sane band of a reference (not 10^n off). PREFER this one-line fix (keeps quorum
breadth); only if the integration is too brittle, fall back to adding OpenOcean to
DISABLED_SOURCES. Record the decision in FEEDBACK.

Commit 2 — Balancer dead: api-v3.balancer.fi/order/{chainId} returns 404; the
adapter has produced 0 prod quotes ever. Add Balancer to DISABLED_SOURCES (per
chain) so it isn't called and doesn't count toward quorum. Mark the adapter
superseded via a header comment (rule #4 — do NOT delete the file): note the v2
order endpoint is 404 and re-enabling needs the Balancer v3 GraphQL SOR endpoint.
Confirm no winner-selection path treats a disabled/erroring source as a 0/null
candidate.

Do NOT: touch contracts, the SC-04 isKnownSwapSelector allowlist, or any on-chain
router whitelist; delete the Balancer file; change other adapters' fail-soft; or
alter the settlement path.

Files (verify on main): openocean.ts (+ test), balancer.ts, DISABLED_SOURCES
config. FEEDBACK: OpenOcean fix-vs-disable decision + Balancer v3-SOR re-enable
path.
```
