# AUDIT-V3-PREDEPLOY — final gate of the v3 arc (ADR-013 deploy step 2)

- **PART A · PR #301 `sprint/v3-p3-cancel-and-hardening` (merged `4277e15`) → ✅ CONFIRMED 0C/0H/0M/0L.**
- **PART B/C · PR #302 `v3 runbook + deploy/verify scripts` (`d147c8b`, draft) → ✅ DEPLOY-AUTHORIZED (0C/0H)**
  — **conditional on applying the 3 MEDIUM runbook/script amendments below (M-A, M-B, M-C) before the owner
  broadcasts §2.** They are doc/script-only edits to the still-unmerged #302; no code re-audit required.

The owner is AUTHORIZED to execute `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` on Base once #302 is revised with
M-A/M-B/M-C. Nothing is deployed by #302 itself (docs + Foundry scripts only).

Base `origin/main` @ `4277e15` (includes #296/#298/#299/#300/#301). All 8 audited commits (#301×5, #302×3)
**SSH-signed**. Sandbox: `forge`/`slither` absent → adversarial source read; CI authoritative (129/129
/api/orders, keeper routing re-run 7/7 last pass). Independent checks this run: EIP-712 v3 typestring
byte-compare at `pr302` (identical), `.sol` bitmap `bitmapPositions` vs `v3-nonce-bitmap.ts`, keeper-file
byte-identity since sign-off, DCA-exemption traced to the contract.

---

## PART A — #301 delta (base already 0C/0H at 954c415)

**1. M-01 conformance — CLOSED.** `route.ts` now derives tokenOut decimals from `fetchErc20Decimals(tokenOut,
chainId)` on-chain — the **sole** decimals source in the floor math; a client `tokenOutDecimals` that
disagrees → **422** (mismatch), a decimals read failure → **422** fail-closed (never falls back to the client
value); the two USD legs combine with **`min()`** (hardest to clear). Single-source no-feed: a validated
single DefiLlama estimate (on-chain decimals, finite price) passes — consistent with the ADR-013 no-feed-
allowed decision — while an *unvalidatable* estimate (unreadable decimals/price) fails closed. The 6 regression
tests exercise the **real `POST` route** (only external I/O mocked): the audit's exact exploit (spoofed HIGH
`tokenOutDecimals` on a DefiLlama-priced/no-feed token) → 422; the inverse LOW spoof; correct-decimals passes;
read-failure → 422; and two min-combine cases. **M-01 fully remediated per prescription.**

**2. v3 single cancel — refuse-guard NARROWED not removed.** Was `if (isV3)` unconditional; now
`if (isV3 && !orderExecutorV3)` — still fires for **every** chain whose v3 address is null (fail-closed). The
wired path targets the correct **per-chain v3 address + `ORDER_EXECUTOR_V3_ABI`**; `buildOrderStructForCancel`
includes `maxSlippageBps` so `cancelOrder()` hashes the exact signed struct; a confirm-time re-check repeats
the guard.

**3. Mass-cancel bitmap — verified against the `.sol` myself.** `v3-nonce-bitmap.ts` mirrors the contract:
`wordPos = nonce>>8`, `bitPos = nonce&0xff`; `computeInvalidationBatches` OR-groups nonces per word (one call
per distinct word); idempotent (set-only bits). **DCA-exemption confirmed against the contract:** the `.sol`
consumes/checks the bitmap only for `orderType != DCA` (`_useUnorderedNonce` / `isNonceUsed` sites), while
`cancelledOrders[hash]` is checked **unconditionally** — so `invalidateUnorderedNonces` has zero effect on DCA,
and the client correctly routes v3 **DCA → individual `cancelOrder()`** and v3 **non-DCA → batched
`invalidateUnorderedNonces`**. The split's `affectedOrders` = v2 ∪ v3-non-DCA ∪ v3-DCA — **nothing silently
skipped**; a v3-only or empty portfolio skips the v2 `invalidateNonces` call (`newNonce=null`).

**4. Gitleaks — 4 suppressions, all sound.** All `generic-api-key` false positives on **test fixtures**
containing public mainnet WETH/USDC addresses (`order_data.tokenIn/tokenOut` field names trip the entropy
heuristic), scoped by exact `commit:file:rule:line` in `.gitleaksignore`. **`.gitleaks.toml` is untouched — no
detection rule weakened.**

**#301 verdict: 0C/0H/0M/0L.** No remediation prompt required.

---

## PART B — #302 runbook + scripts

**1. `DeployOrderExecutorV3.s.sol` — sound.** Every constructor param is `vm.envAddress/envUint` **by name, no
default** (no embedded production address). The plaintext-key guard **actually fires** (`try envString("PRIVATE_KEY")`
→ non-empty & not `ALLOW_PLAINTEXT_KEY[_MAINNET]` → `require` reverts). Chain-id assert present
(`block.chainid == EXPECTED_CHAIN_ID`). **Owner=timelock:** the runbook sets `ADMIN` = the v2 EOA
`0x9A38…C73C`; ALL fund/config-relevant admin actions (router/oracle/admin/sweep/executor) are gated by the
contract's OWN 48h/7d queue→execute timelock, and the only instant powers are `pause`/`unpause` (fail-safe) and
`setOracleConfig` (trigger-feed only, output still floor-bounded) — bounded, and **parity with the live v2**.
The [Key Hardening] admin→Safe/HW migration (W1-L-02) applies to v3 too but is not a v3-deploy blocker.
*(INFO, not blocking.)*

**2. `VerifyOrderExecutorV3.s.sol` — 7 assertions sufficient EXCEPT two immutable params (→ M-A).** `run()`
asserts: code present, chainId, `admin==expected`, `MAX_ORDER_SLIPPAGE_BPS==500`, each expected router
whitelisted (+non-empty set), `sequencerUptimeFeed==expected`, `bootstrapped==true`, `paused==false`, and an
EIP-712 domain-separator recompute (name/version "3"/chainId/verifyingContract). `checkOracleFeed` adds
registered + live-decimals-match + fresh positive answer. **Virgin bitmap/dcaExecutions/cancelledOrders state
is guaranteed by construction** (a fresh deploy zero-inits all mappings) — no assertion needed. **Gap (M-A):
`feeRecipient()` and `WETH()` — both immutable and fund/correctness-relevant — are declared in the interface
but NEVER asserted, and no runbook §3 step checks them.** A fat-fingered `FEE_RECIPIENT` env → 0.1% of all
Base DCA volume misdirected permanently; a wrong `WETH` → the H-02 ETH-output path breaks (liveness). Neither
is caught by the e2e smoke (which checks a fill clears the floor, not the fee destination or the WETH branch).
Bounded (no user-output drain — output stays floor-bounded + `recipient==owner`), so not C/H, but a one-shot
immutable deploy should not leave them unverified.

**3. Runbook fail-open walk:** oracle-config (§4, 48h timelocked) completes **before** the §5 env cutover — no
fill-blind window (unconfigured pairs fall to the signed-min no-feed path, safe). The keeper cannot pick up or
the frontend sign a v3 order before §5 (both gated on the env vars set only after §3+§4 verification pass).
Gate condition 3 requires v3 cancel **live in the production build before deploy**, re-validated by the §5.4
e2e smoke (Create→Fill→single-cancel→mass-cancel) — no window where a v3 order exists without cancel support.
Phase-0 retirement (§7) correctly gated on **all** DCA chains + a separate sprint. **Two rollback/ordering
issues:**
  - **M-B (§6, post-first-order rollback — internal contradiction):** step 1 says "unset the same two env
    vars" while step 2 + the rationale say "do **not** touch `ORDER_EXECUTOR_V3_ADDRESS` in the keeper env,
    only the frontend signing switch." Following step 1 literally unsets the keeper's v3 address → the keeper
    skip+flags every existing v3 order → users hold **unexecutable AND uncancellable** v3 orders (a stop-loss
    can't fire; the exact harm #301 exists to prevent). Fix step 1 to unset **only** the frontend
    `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE`; keep the keeper's `ORDER_EXECUTOR_V3_ADDRESS` set.
  - **L-A (§5 cutover ordering):** Step 1 (frontend signing) precedes Step 2 (keeper env). Setting the keeper
    env **first/together** eliminates a transient window where freshly-signed v3 orders are skip+flagged until
    the keeper restarts (safe either way — delay-not-loss — but keeper-first is strictly cleaner).

**4. Timelock discipline — correct.** §4 fair-value oracle config is 48h queue→wait→execute→verify with an
explicit calendar-wait step and grace-window note; no instant path to `tokenUsdFeeds`. The instant
`setOracleConfig` (trigger feed) and instant `pause` are documented v2-parity / fail-safe. Sweep, router,
executor, admin all timelocked.

**Additional — M-C (router-set spec muddled across §2/§3/config):** §2 Step 3 defaults to "same router set as
v2's Base bootstrap" (v2 has ~10), the §3 verifier **example** passes only `[augustusV6]`, but the frontend
(`config.ts BASE_ROUTERS`, `getWhitelistedRouters(8453)`) serves **exactly two** — Augustus V6
`0x6A000F…1068` **and** Uniswap SwapRouter02 `0x2626664c…e481`. Consequences: bootstrapping V6-only (per the §3
example) → a user picking Uniswap signs `order.router=0x2626…` → `executeOrder` reverts `RouterNotWhitelisted`
(that DCA path can't fill until a 48h-timelocked add); bootstrapping all 10 (per §2 Step 3) → 8 dead
whitelist entries (unreachable — the frontend never signs them and `/api/swap` won't serve them, so bounded,
but a least-privilege smell on a one-shot bootstrap). Fix: state the **exact** v3 Base bootstrap set =
`getWhitelistedRouters(8453)` (V6 + SwapRouter02), bootstrap exactly those, pass **both** to the §3 verifier,
and run the mandatory `Bootstrap`/`RouterWhitelisted` event scan to confirm no extras (§3 already flags that
the on-chain verifier can't prove exact-whitelist from a single read).

---

## PART C — repo state (all clean)

- **No v3 address configured anywhere:** `ORDER_EXECUTOR_V3_BY_CHAIN` is env-name-only (`|| null`);
  `.env.example` leaves `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS[_BASE]` + keeper `ORDER_EXECUTOR_V3_ADDRESS`
  **unset** with fail-closed comments; no hardcoded non-null v3 default in the repo. The "no two chains share a
  verifyingContract" load-time invariant is present.
- **`order-floor.js` + `submission-policy.js` byte-identical** to the sign-off base (`a81cb4c`) through `pr302`.
- **Frontend EIP-712 v3 typestring byte-matches the `.sol`** at `pr302` (verified programmatically); the `.sol`
  is unchanged by #302.
- **`docs/DEPLOYMENTS.md` consistent** with runbook §0: feeRecipient `0x107F…`, admin `0x9A38…`, Base WETH
  `0x4200…0006`, Base v2 OrderExecutor `0x135B…2598` all match.

## Findings (all bounded, none C/H — do not block the 0C/0H authorization; apply M-A/M-B/M-C to #302 first)

- **M-A · `VerifyOrderExecutorV3.s.sol` `run()` + runbook §3 · MEDIUM.** `feeRecipient()` / `WETH()` (immutable)
  unverified and unchecked by any runbook step. Remediation below.
- **M-B · runbook §6 (post-first-order rollback) · MEDIUM.** Step-1/step-2 contradiction strands existing v3
  orders if followed literally. Remediation below.
- **M-C · runbook §2 Step 3 / §3 verifier example vs `config.ts` · MEDIUM.** v3 Base router set under/over-
  specified. Remediation below.
- **L-A · runbook §5 · LOW.** Set the keeper v3 env before the frontend signing switch to avoid a transient
  skip-flag window.
- **INFO · admin = v2 EOA `0x9A38…C73C`.** Bounded by the contract's own 48h/7d timelock; [Key Hardening]
  admin→Safe/HW (W1-L-02) applies to v3 but is not a deploy blocker (parity with live v2).

### Remediation prompts (Code-Agent-ready — #302 doc/script amendments, no re-audit)

**M-A.** *Objective:* the post-deploy verifier must assert every immutable fund/correctness param.
*Requirements:* extend `VerifyOrderExecutorV3.run(...)` to take `expectedFeeRecipient` and `expectedWeth` and
`require(oe.feeRecipient()==expectedFeeRecipient, "…")` + `require(oe.WETH()==expectedWeth, "…")`; update the
runbook §3 verifier invocation + the `--sig` signature to pass the §0 values. *Files:*
`contracts/order-engine/script/VerifyOrderExecutorV3.s.sol`, `docs/Runbooks/V3-EXECUTOR-DEPLOY.md` §3.

**M-B.** *Objective:* the post-first-order rollback must never strand existing v3 orders. *Requirements:* in
§6 "After a real v3 order exists", change step 1 to unset **only** `NEXT_PUBLIC_ORDER_EXECUTOR_V3_ADDRESS_BASE`
(frontend signing) and explicitly say to **keep** the keeper's `ORDER_EXECUTOR_V3_ADDRESS` set so existing v3
orders stay executable/cancellable — aligning step 1 with step 2 and the rationale. *Files:*
`docs/Runbooks/V3-EXECUTOR-DEPLOY.md` §6.

**M-C.** *Objective:* one unambiguous v3 Base router set, least-privilege, matching the frontend. *Requirements:*
in §2 Step 3 state the exact set = `getWhitelistedRouters(8453)` (Augustus V6 `0x6A000F…1068` + Uniswap
SwapRouter02 `0x2626664c…e481`); bootstrap exactly those two; in §3 pass **both** to the verifier's router
array; keep the mandatory `Bootstrap`/`RouterWhitelisted` event-scan step to confirm no extras. *Files:*
`docs/Runbooks/V3-EXECUTOR-DEPLOY.md` §2 Step 3 + §3.

_Read-only; no source edited. Report + AUDIT-TOTAL block left for the owner's SSH-signed batch (rule #12)._
