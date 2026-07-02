# SEC-4 · Wave 8 — Keeper / order engine (the A5 surface) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-4 (parallel after W0). **Runner:** Auditor (read-only). **Baseline:**
> `origin/main` (cb0748d) per plan §0 — read via `git show origin/main:<path>`. **Grounded on:** W0-recon.md §2 +
> W1/W2 (on-chain guards bound a hostile keeper) + W4 (Base OE `0x135B`, Augustus V6) + W5 (keeper signs a reviewed
> payload). **Source of truth:** T-SAF v1 §5-W8 + §6 INV-7/8/9 + §9 G1/G6/G7/G10. **Binding:** T-SAF §1 + CLAUDE.md
> #1/#2/#3/#8/#12.

## Objective
Prove that **even a fully compromised keeper key cannot misroute or drain user funds via the contract**, the freeze
is **delay-not-loss** with a single admin writer (no auto-freeze), observability can't be blinded into silence, and
the keeper's own hardening (KMS-only signing, plaintext-key guard, outflow detection) holds on **both chains**.

## In-scope (W0 §2.7 — keeper/order-engine)
`contracts/order-engine/executor/{executor,alert,freeze-score}.js`, KMS/Vault signing, the Supabase `circuit_breaker`
freeze flag + its API writer, outflow detection, the Cloudflare Worker cron → `monitor/tick`. Plus the
session-added keeper logic if present on main: **DCA resilience (#246)** retry/terminal-status, **cross-agg
deviation guard (#248)** defer-then-execute, execution recording.

## Attacker goal (A5; §5-W8, §9)
With a **compromised keeper KMS key**: drain via `executeOrder` or a direct tx; **abuse the freeze flag**
(weaponize as DoS, or strand user funds); **blind the observability** (suppress alerts); double-execute or
mis-route a fill.

## Must-verify invariants (INV-7/8/9; negative-path first)
1. **Keeper compromise bounded by ON-CHAIN guards (the crux):** even a hostile keeper can only call `executeOrder`,
   which the OrderExecutor gates — recipient = `order.owner`, on-chain `minimumOutput`, **chain-correct router
   whitelist** (Base V6 / mainnet V5, W1/W4) — so a key compromise **cannot misroute *via the contract***. Prove the
   keeper cannot construct a settling calldata that bypasses these (e.g. a non-whitelisted router, recipient≠owner).
2. **Signs only the reviewed executeOrder payload** (W5) — the keeper's KMS-signed tx == the order it read from
   Supabase; no re-target.
3. **Freeze = delay-not-loss (INV-9):** freeze skips execution + blocks NEW orders; it does **NOT** cancel/modify
   orders, touch funds/approvals, or lose cumulative progress; resumes on unfreeze. **Single writer:** only the
   admin-Bearer endpoint writes `circuit_breaker` — `freeze-score.js`/`alert.js`/keeper **never** write it
   (no auto-freeze). `pause()` is the DB-independent nuclear stop.
3b. **DCA resilience (#246) / deviation guard (#248) if on main:** a defer/retry NEVER drains or double-executes —
   defer is a distinct state (not counted as a failure, not a settle), retry is idempotent (no double-fill),
   and the on-chain guards from (1) still bound every eventual execution.
4. **Fail-open reads vs fail-safe `pause()` split** is correct (INV-8): advisory reads fail open (a compromised key
   bypasses the keeper anyway), but `pause()` is the hard stop.
5. **Outflow detection** threshold sane — own-gas subtracted; a non-gas ETH outflow from `0x71f5` = anomalous → alert.
6. **Plaintext-key guard covers BOTH chainId 1 AND 8453** (known gap: guard only fired on chainId 1 → on Base a
   plaintext key would be accepted; verify whether fixed on main; the keeper should force KMS/Vault on all prod chains).
7. **Observability non-blocking + secrets never logged** — the alert path can't be silenced into a fund-moving blind
   spot; KMS key id / Bearer / bot token never logged.

## Method & tools (§7.5)
Re-run keeper `node --test` (not in CI — always re-run; record counts). Trace the **freeze gate + its single writer**;
**simulate a KMS-hostile keeper** and confirm the on-chain guards (W1/W2) still bound the damage (recipient/minOut/
router). Verify `pause()` is the documented nuclear stop. Grep the plaintext-key guard's chainId condition. Grep
secrets-in-logs. Confirm the Worker cron authenticates to `monitor/tick`.

## Negative-path battery (each must be refused/bounded)
Hostile keeper → executeOrder with recipient≠owner / non-whitelisted router / minOut violated → **on-chain revert** ·
non-admin writes the freeze flag → refused · freeze that cancels/strands an order → must not happen · plaintext key
on Base → refused (or flagged as the gap) · unauth Worker → `monitor/tick` refused · a defer/retry that double-fills.

## Exit criteria
Keeper compromise is bounded by on-chain guards (no misroute via the contract); delay-not-loss proven; single freeze
writer + no auto-freeze; plaintext-key guard covers both chains (or the gap is filed); observability unblindable;
secrets unlogged. Findings → §4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Wave 8 (Keeper / order-engine — A5 surface) per Audits/Campaign/2026-07-01/
W8-keeper.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W8. READ-ONLY, no code edits.
Baseline origin/main (cb0748d) — read via `git show origin/main:<path>`; record
the audited SHA. Ground on W1/W2 (on-chain guards), W4 (Base OE 0x135B, V6), W5.

Scope: contracts/order-engine/executor/{executor,alert,freeze-score}.js, KMS/
Vault signing, Supabase circuit_breaker freeze flag + its API writer, outflow
detection, Cloudflare Worker cron -> monitor/tick. Plus (if on main): DCA
resilience #246, cross-agg deviation guard #248, execution recording.

Prove (negative-path FIRST — each must be refused/bounded):
1. Keeper compromise bounded ON-CHAIN (crux): a hostile keeper can only call
   executeOrder, gated by recipient=order.owner + on-chain minimumOutput +
   chain-correct router whitelist (Base V6 / mainnet V5) -> cannot misroute VIA
   the contract. Prove no settling calldata bypasses these.
2. Keeper signs only the reviewed executeOrder payload (KMS tx == the Supabase
   order; no re-target).
3. Freeze = delay-not-loss: skips exec + blocks NEW orders; does NOT cancel/
   modify/touch funds/approvals; resumes on unfreeze. SINGLE writer = the
   admin-Bearer endpoint only; freeze-score/alert/keeper never write it (no
   auto-freeze); pause() = nuclear stop.
3b. #246/#248 if on main: a defer/retry never drains or double-executes (defer
   is not a settle, retry is idempotent, on-chain guards still bound every exec).
4. Fail-open reads vs fail-safe pause() split correct.
5. Outflow detection threshold sane (own-gas subtracted; non-gas ETH outflow
   from 0x71f5 -> alert).
6. Plaintext-key guard covers BOTH chainId 1 AND 8453 (known gap: fired only on
   chainId 1 -> Base would accept a plaintext key; verify if fixed on main).
7. Observability non-blocking; secrets (KMS id/Bearer/bot token) never logged;
   Worker cron authenticates to monitor/tick.

Tools: re-run keeper node --test (record counts); trace freeze gate + single
writer; simulate KMS-hostile keeper and confirm on-chain guards bound it; verify
pause() nuclear stop; grep the plaintext-key guard chainId condition; grep
secrets-in-logs. On-chain via viem/node.

Deliver into Audits/Campaign/2026-07-01/W8-keeper.md (report section): audited
SHA, checks table, findings (Sev·file:line·disposition + §4 evidence bundle),
negative-path results, coverage fraction of the keeper slice, verdict (0C/0H
bar), remediation-prompt list. SSH-signed commit left for owner if no key in
sandbox.
```

---

# WAVE 8 — REPORT (executed 2026-07-01, Auditor, read-only)

**Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via
`git show origin/main:<path>`; working tree `df00d35` ignored per W3-H-01). **Keeper `node --test`
re-run (viem resolvable): 127/127 pass.**

## Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I
A keeper (KMS) compromise is **bounded on-chain** — a hostile keeper can only submit user-signed
`executeOrder` calls, which the contract forces to deliver to `order.owner` with on-chain `minimumOutput`
and a chain-correct router whitelist. Freeze is delay-not-loss with a single admin writer (no auto-freeze);
#246 retry is idempotent and #248 defer is not a settle; the **known plaintext-key Base gap is FIXED on
main**; observability is non-blocking and logs no secret. Clean wave.

## Checks-run (negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | **Keeper compromise bounded on-chain (crux)** | ✅ Keeper calls `executeOrder(orderStruct, dbOrder.signature, swapData.data)` (`executor.js:1191-1195`). The contract re-verifies `signer==order.owner`, delivers output to `order.owner`, enforces on-chain `minimumOutput` (balance-delta), and requires a **whitelisted** router (mainnet V5 / Base V6, W1/W4). A hostile keeper **cannot misroute via the contract**; DCA arbitrary `routerData` is bounded by minOut+owner-delivery+nonReentrant (W1). Residual: only the executor's own gas wallet + a direct-tx drain (answer = `pause()` + key rotation, on-chain-independent). |
| 2 | Keeper signs only the reviewed executeOrder payload | ✅ `orderStruct` + `signature` are read from the Supabase order (`order_data`, user-EIP-712-signed); no re-target. The keeper cannot forge a signature (needs the user key) nor redirect output (contract-enforced owner). |
| 3 | Freeze delay-not-loss + single writer | ✅ Keeper `readFreezeFlag()` (`:519`, fail-open) → skips DCA exec, leaves order `active` (resumes on unfreeze); create API returns 403 (W6/201). **Keeper NEVER writes `circuit_breaker`** (only the `?select=frozen` read + an alert) → single writer = the admin-Bearer endpoint; **no auto-freeze**; `pause()` = nuclear stop. |
| 3b | #246 retry idempotent / #248 defer ≠ settle | ✅ `retry-policy.js` (dca-resilience) classifies transient vs permanent, schedules a backoff **left active** (no re-send this cycle); a re-attempt after an actually-successful exec is rejected on-chain (nonce single-use / DCA interval+counter) → **no double-exec**; `record-execution.js` is confirmed-only + idempotent. `deviation-guard.js` (#248) **DEFERS** a drifted DCA fill (skip, not a settle → no drain) and "never fails, never [executes]". |
| 4 | Fail-open reads vs fail-safe `pause()` | ✅ Freeze read fails open (transient DB error ⇒ keeper keeps running); the on-chain `pause()` (admin, timelock-independent) is the real hard stop — correct split (201 ruling, re-confirmed). |
| 5 | Outflow detection sane | ✅ `unexplainedOutflowEth = max(0, (start − end − ownGasSpentWei)/1e18)` (`:832`); **own gas subtracted**; `> OUTFLOW_THRESHOLD_ETH` (0.01, env-tunable) → `alertUnexplainedOutflow` (non-blocking). Detects a non-gas ETH drain from the executor wallet. |
| 6 | **Plaintext-key guard covers BOTH 1 AND 8453** | ✅ **FIXED on main.** Inverted to a `TESTNET_CHAIN_IDS` allowlist `{11155111 Sepolia, 84532 Base Sepolia}` (`:150`); a plaintext `EXECUTOR_PRIVATE_KEY` without KMS/Vault on any **non-testnet** chain (incl. Base 8453) → **FATAL `process.exit(1)`** unless the explicit `ALLOW_PLAINTEXT_KEY` override (`:253-267`). The known "chainId 1 only" gap is closed. |
| 7 | Observability non-blocking; secrets unlogged; cron authed | ✅ All alert/score/read paths wrapped never-throw (201); `console.*` logs only **env-var names** in the key-guard guidance, never a secret **value**; the Cloudflare Worker POSTs `/api/monitor/tick` with `Authorization: Bearer ${MONITOR_CRON_SECRET}` (`workers/monitor-tick-cron/src/index.ts:56`) which the route verifies via `verifyBearerToken` (W6). |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W8-I-01 | INFO | `executor.js:258` (`ALLOW_PLAINTEXT_KEY`) | REPORT | The documented escape hatch bypasses the production-chain plaintext-key refusal (warned, DANGEROUS). Operational: ensure `ALLOW_PLAINTEXT_KEY`/`_MAINNET` is **never** set in prod env; the intended posture is KMS/Vault (aligns with the [Key Hardening] plan). No code change. |
| W8-I-02 | INFO | `executor.js:832` (outflow) | REPORT | Carry from 201: outflow is **per-cycle** (a sub-0.01-ETH/cycle slow drain evades this specific signal; mitigated by the low-gas signal) and over-alerts on a legit manual keeper-wallet withdrawal. Advisory-only, never auto-freeze. Consider a rolling-window accumulator (future). |

## Negative-path battery (each bounded/refused)
Hostile keeper misroutes via executeOrder → contract delivers to `order.owner` (impossible) ✅ · keeper forges an
order → signature won't recover to owner → contract reverts ✅ · keeper re-executes a completed order → nonce/DCA-
counter revert (no double) ✅ · keeper writes the freeze flag → no write path (single admin writer) ✅ · plaintext
key on Base without KMS → FATAL exit ✅ · deviation-drifted DCA fill → deferred (not settled) ✅ · unauth POST to
`/api/monitor/tick` → 401 (W6) ✅ · freeze DB unreachable → fail-open keeps running, `pause()` is the hard stop ✅.

## Coverage (keeper slice)
- Source-reviewed on `main`: `executor.js` (1525 lines — signing/exec/freeze/outflow/retry/defer), `alert.js`,
  `freeze-score.js`, `retry-policy.js`, `deviation-guard.js`, `record-execution.js`, `kms-signer.js` (ref),
  the Cloudflare Worker (`workers/monitor-tick-cron`), the `circuit_breaker` writer (admin route, W6/201).
- **Keeper `node --test`: 127/127** (freeze-score/alert/retry-policy/deviation-guard/record-execution/revert-decode/…).
- On-chain: reused W1/W4 — OrderExecutor guards (owner-recipient + minOut + per-chain whitelist V5/V6).
- Not run in-sandbox: a live KMS-hostile simulation / real `pause()` (human-only, on-chain governance) — reasoned
  from the contract guards (W1) which bound any keeper tx.

## Remediation prompts
- **None required** (0C/0H/0M/0L). W8-I-01 is an ops note (never set `ALLOW_PLAINTEXT_KEY` in prod; complete the
  Admin/keeper→KMS/HW hardening). W8-I-02 is an optional future rolling-window outflow accumulator.

## Boundaries
Read-only on `origin/main`; no live keeper run, no KMS ops, no `pause()`/on-chain governance (human-only). W9
(wallet/frontend) + W10 (infra/CI) consume: keeper compromise is on-chain-bounded; the Worker cron secret is a
W10 infra secret; plaintext-key guard now covers Base.
