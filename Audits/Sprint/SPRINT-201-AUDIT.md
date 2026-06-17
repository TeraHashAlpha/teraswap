# Sprint 201 Audit — DCA Observability + User-Safe Manual Freeze

**Branch:** `sprint/dca-observability-freeze` / PR #201 — **Commit:** `4f9cee3` (SSH-signed; `gpgsig … BEGIN SSH SIGNATURE`).
**Prompt:** `docs/Prompts/AUDIT-201-DCA-FREEZE.md`. **Reviewer:** independent Auditor (Opus 4.8), read-only on source.
**Surface:** advisory observability (Telegram alerts + 0–20 freeze-urgency score) + a **manual, admin-only freeze that gates DCA order execution**. SECURITY-relevant (gates execution) → rules #2/#3 apply.
**Diff:** 16 files, +2187/−2. Core: `executor/{alert,freeze-score,executor}.js`, `api/admin/dca-freeze/route.ts`, `api/orders/route.ts`, `lib/dca-freeze.ts`, `supabase/circuit-breaker.sql`, `docs/Runbooks/DCA-FREEZE.md`.
**Tests re-run in-session:** keeper `node:test` **18/18** (freeze-score 12/12 + alert 6/6) — the keeper is **not** in CI; re-executed against the branch tree.

---

## Verdict: APPROVED — 0C / 0H / 0M / 1L / 6I

The user-safety invariant holds on every traced path; the bot can never auto-freeze (the only writer of the flag is the admin-Bearer endpoint); the observability layer is strictly non-blocking and mainnet byte-identical when not frozen + Telegram unset. One LOW (admin freeze can falsely report success when Supabase is unconfigured) and six INFO notes — none block. **0C/0H ⇒ cleared for the Architect to merge.**

---

## Must-verify results

### 1. User-safety invariant — freeze = delay, never loss ✅ (highest priority)
Code-traced + test-confirmed:
- **No cancel/modify of existing orders, no funds/approvals moved.** While frozen the keeper (`executor.js:831`) returns a DCA order to `active` and `continue`s — `executeOrder` is never called, so no on-chain action, no token pull, no approval change. The flag is data-only.
- **New DCA → 403, `insert` never reached.** `api/orders/route.ts:124` calls `getDcaFreezeState()` **inside** the `orderType === 'dca'` branch (line 98) and **before** the shared `.insert()` (line 229); frozen ⇒ `403 { frozen:true }`. Non-DCA (limit/stop_loss) skip the gate entirely → byte-identical. Pinned by `orders-freeze.test.ts`.
- **Cancel + revoke stay available.** `getDcaFreezeState` is imported by **only** `api/orders/route.ts` and the admin route — the cancel route (`orders/[id]/route.ts`) never reads the flag, so cancellation is always allowed; approvals are user-controlled on-chain.
- **Pending DCAs resume after unfreeze.** The frozen order is left `active` with `dca_last_exec`/`dca_executed` untouched ⇒ the contract's cumulative tracking is unchanged ⇒ it executes on a later cycle once unfrozen. Delay-not-loss confirmed; no path found that strands funds or harms a user.

### 2. No auto-freeze — single admin writer ✅
The **only** writer of `circuit_breaker` is `setDcaFreezeState`, called **only** from `POST /api/admin/dca-freeze:85` after `authorize()`. The keeper (`executor.js:427`) and every alert/score path **read-only** (`select=frozen,reason`) or never touch the table. The 0–20 score (`freeze-score.js`, pure/no-I/O) feeds alert wording only — it triggers **no** state change and cannot set the flag. SQL `circuit-breaker.sql`: RLS deny-all to anon/authenticated; only `service_role` writes.

### 3. The 5 by-design trade-offs — explicit rulings
| # | Trade-off | Ruling |
|---|-----------|--------|
| 1 | Admin auth = **Bearer secret** (`DCA_FREEZE_SECRET`), not the `0x9A38` wallet | **BLESS.** `0x9A38`/`NEXT_PUBLIC_ADMIN_WALLET` is only the client UI gate; the server enforces the secret via `verifyBearerToken` — SHA-256 both sides then `timingSafeEqual` on fixed-length digests (constant-time, no length leak), server-only, not logged. Mirrors `kill-switch`. Sound. |
| 2 | **Fail-open reads** (unreadable flag ⇒ NOT frozen) | **BLESS** (see detailed reasoning below). The on-chain `pause()` — independent of Supabase — is the real fail-safe; fail-closed would be a self-inflicted liveness footgun with no security gain. INFO recommendation 201-I-01. |
| 3 | Freeze-honor **locks before skipping** (lock→`active` each cycle) | **BLESS.** Delay-not-loss holds; cost is one lock+PATCH per frozen DCA per cycle (churn under a long freeze). Optional pre-lock `order_type` check — INFO 201-I-05. |
| 4 | Outflow **over-alerts** on manual withdrawals; ETH/USD staleness unchecked; in-memory new-DCA dedup | **BLESS.** All advisory, never a gate (Chainlink-validation rule #9 applies to *gates*, not to an observability signal). Over-alert + never-auto-freeze is the safe direction. INFO 201-I-02/03/06. |
| 5 | `setDcaFreezeState` returns requested state **without throwing** when Supabase unconfigured | **ACCEPT-WITH-HARDENING → LOW 201-L-01.** Inconsistent with the upsert-error path (which throws → 503); a misconfigured/unreachable backend makes the admin freeze **falsely report success**. Recommend fail-closed on the *write* path. |

**Detailed ruling on fail-open (trade-off #2 / attack scenario in the brief).** The question: *does fail-open create a window if the DB is unreachable while you try to freeze a compromised executor?* No — for three reasons. (a) The freeze flag is an application-layer brake on the keeper's *DCA execution*, not a fund-flow control: `executeOrder` is itself on-chain-guarded (recipient gating, on-chain `minimumOutput`, router/selector allowlist), so a still-running legitimate keeper during a DB outage simply executes valid user orders — no loss, just no pause. (b) If the *executor key* is compromised, the attacker bypasses the keeper code entirely and drains via direct txs — the freeze flag (fail-open *or* fail-closed) cannot stop that; the answer is on-chain `pause()` + key rotation, which the runbook documents as the nuclear escalation and which does not depend on Supabase. (c) Fail-closed would let a transient Supabase blip halt **all** DCA execution for **all** users with zero security benefit. Fail-open is therefore the correct default. *Recommendation (INFO, not required):* keep `pause()` as the authoritative stop for confirmed compromise (already documented); an optional `FREEZE_FAILCLOSED` env for an elevated-threat posture could be a future toggle, but adds a liveness risk and is not needed for approval.

### 4. Unexplained-ETH-outflow detection ✅ (with INFO caveats)
`endCycleObservability` computes `outflow = max(0, startBalance − endBalance − ownGasSpentWei)` and alerts when `> OUTFLOW_THRESHOLD_ETH` (default **0.01 ETH**, env-configurable). `ownGasSpentWei` **is** accumulated per successful `executeOrder` (`executor.js:967–971` and `:1038`, `gasUsed × effectiveGasPrice`), so the executor's own gas is correctly subtracted — the dominant false-positive source is bounded.
- **Threshold sanity:** for a Base hot-gas wallet, per-cycle own-gas is cents; 0.01 ETH (~$25–35) beyond that is a meaningful anomaly floor, low enough to catch a real drain. Sane default. ✅
- **False positives (201-I-03):** a manual operator withdrawal, or any non-`executeOrder` tx whose receipt isn't summed (e.g., `effectiveGasPrice` missing ⇒ `|| 0n` ⇒ that tx's gas not subtracted), would over-alert. Advisory only (Telegram) — acceptable.
- **False negatives (201-I-02):** the check is **per-cycle**, so a drip-drain kept under 0.01 ETH/cycle evades the outflow signal specifically; mitigated by the low-gas signal and the lump-sum nature of real KMS drains. Consider a rolling-window/cumulative accumulator (future). INFO.

### 5. Non-blocking + byte-identical ✅
`sendTelegramAlert` no-ops when `TELEGRAM_*` unset and never throws (10s `AbortController` + try/catch); every keeper alert/score/freeze-read call is wrapped `/* never throw */` and each reader is fail-open. An alert/score/DB failure therefore can never stop or alter execution. When not frozen + Telegram unset, no execution decision changes — mainnet byte-identical; the added work is non-blocking observability reads. Secrets: `DCA_FREEZE_SECRET` and `TELEGRAM_BOT_TOKEN` are server/env-only, never logged (the token sits in the request URL but only `err.message` is logged — INFO 201-I-04).

### 6. Pre-activation dormancy ✅
Until the operator applies `circuit-breaker.sql` and sets `DCA_FREEZE_SECRET`: both readers fail-open (missing table/row ⇒ NOT frozen ⇒ keeper + create-API behave exactly as today) and the admin route returns `503` (can't freeze yet). Dormant state is safe; nothing breaks.

---

## Findings

| ID | Sev | file:line | Disposition | Description |
|----|-----|-----------|-------------|-------------|
| 201-L-01 | LOW | `src/lib/dca-freeze.ts:106–110` | REMEDIATION-PROMPT | `setDcaFreezeState` returns `{frozen,…}` (no throw) when `getSupabase()` is null ⇒ `POST /api/admin/dca-freeze` answers **200 with the requested state** while nothing persisted. An operator could believe DCA is frozen when it isn't. Inconsistent with the upsert-error branch (throws → 503). Fix: treat unconfigured backend as a write failure (throw → route 503) so the admin gets an explicit failure. Not user-exploitable; `pause()` remains the real stop. |
| 201-I-01 | INFO | `dca-freeze.ts` / `executor.js:readFreezeFlag` | REPORT | Fail-open reads blessed; keep `pause()` as the authoritative confirmed-compromise stop (documented). Optional future `FREEZE_FAILCLOSED` toggle for elevated threat — not required. |
| 201-I-02 | INFO | `executor.js:690+` | REPORT | Per-cycle outflow threshold can miss a sub-0.01-ETH/cycle drip-drain (false negative); mitigated by low-gas signal. Consider rolling-window accumulator. |
| 201-I-03 | INFO | `executor.js:966` | REPORT | Outflow over-alerts on manual keeper-wallet withdrawals / untracked txs (`effectiveGasPrice || 0n` ⇒ that gas not subtracted). Advisory only — acceptable by design. |
| 201-I-04 | INFO | `executor/alert.js:80` | REPORT | Telegram bot token is in the request URL; currently only `err.message` is logged (safe). Keep URL / `err.cause` out of any future logging on this path. |
| 201-I-05 | INFO | `executor.js:831` | REPORT | Freeze-honor locks then returns to `active` ⇒ per-cycle lock+PATCH churn per frozen DCA. Optional pre-lock `order_type` check reduces churn. |
| 201-I-06 | INFO | `executor.js:maybeAlertNewDca` | REPORT | New-DCA dedup is in-memory ⇒ at-least-once re-alert after a keeper restart for a still-fresh position. Harmless. |

## Remediation prompt — 201-L-01 (Code-Agent-ready)
> **Context:** `setDcaFreezeState` (`src/lib/dca-freeze.ts`) returns the requested state without persisting when `getSupabase()` is null, so `POST /api/admin/dca-freeze` falsely reports a successful freeze under a misconfigured/absent Supabase backend.
> **Objective:** Make the freeze **write** path fail-closed: when the backend is unconfigured, surface a failure instead of a false success.
> **Requirements:** In `setDcaFreezeState`, when `!sb`, `throw new Error('DCA freeze backend unconfigured')` (do **not** return a fabricated state). The admin route already catches write errors → `503`; confirm `POST /api/admin/dca-freeze` returns `503` in this case. Leave the **read** path (`getDcaFreezeState`) fail-open and unchanged. Do not touch the keeper, the gate logic, or any other file.
> **Tests:** add a case to `src/lib/dca-freeze.test.ts` (unconfigured Supabase ⇒ `setDcaFreezeState` rejects) and to `src/app/api/admin/dca-freeze/route.test.ts` (unconfigured ⇒ `POST` → 503). Keep all existing tests green.
> **Quality:** atomic SSH-signed commit; CI green; append FEEDBACK. Read-only-on-gate logic — this is a non-gate correctness fix; re-audit not required (LOW, no fund-flow/gate change).

## Keeper test re-run (not in CI)
`node --test` against the branch tree: `freeze-score.test.mjs` **12/12**, `alert.test.mjs` **6/6** = **18/18 pass**.

## Counter-sign
LIGHT/standard Auditor: **APPROVED — 0C/0H** (1L + 6I, none blocking). Cleared for merge per rules #2/#3. The keeper is not covered by CI — the operator must re-run `node --test contracts/order-engine/executor` in the deploy pipeline. Human-only boundaries (applying `circuit-breaker.sql`, setting `DCA_FREEZE_SECRET`/`TELEGRAM_*`, any on-chain `pause()`) are documented in `docs/Runbooks/DCA-FREEZE.md` — not exercised here.
