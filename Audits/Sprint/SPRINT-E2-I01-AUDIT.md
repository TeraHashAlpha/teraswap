# LIGHT Audit — E2-I-01: Sequencer gate on the Base swap-build path

**Branch:** `fix/sequencer-swap-path` / PR #170 — **Commit:** `3079d67` (SSH-signed; `gpgsig … BEGIN SSH SIGNATURE` present).
**Reference:** `Audits/Sprint/SPRINT-E2-AUDIT.md` finding **E2-I-01** (belt-and-suspenders follow-up to the E-2 quote gate, PR #167).
**Prompt:** `docs/Prompts/E2-FOLLOWUP-SEQUENCER-SWAP-PATH.md`.
**Classification:** SECURITY GATE (rule #9), **additive**. **Scope:** LIGHT.
**Diff:** 2 files, +95/−0 — `src/app/api/swap/route.ts` (+25), `src/app/api/swap/route.test.ts` (+70). No other file touched.
**Tests:** re-executed in-session — **24/24 pass** (`src/app/api/swap/route.test.ts`, incl. 4 new E2-I-01 cases).

---

## Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I

The gate strictly reuses the E-2 single source of truth, preserves the fail-safe direction, is mainnet
byte-identical (test-pinned to **zero** sequencer calls), is correctly placed before the rate limiter and
upstream fetch, and returns a 503 body byte-identical to the quote gate. No Critical/High/Medium/Low.

---

## Checks (per owner brief)

| # | Check | Result |
|---|-------|--------|
| 1 | **Strict reuse of `sequencer-check.ts` — no fork of feed / grace / threshold** | ✅ The commit touches **only** `route.ts` + `route.test.ts`; `sequencer-check.ts` is **unchanged**. The route imports `isSequencerUp, SequencerDownError` from `@/lib/chains/sequencer-check` and `getPublicClientForChain` from `@/lib/chains/clients`, and calls `isSequencerUp(Number(chainId), getPublicClientForChain(Number(chainId)))` — the exact shape used by the quote gate (`src/lib/api.ts:107`). The feed address (`getChainConfig(chainId).sequencerUptimeFeed`), the grace window (`SEQUENCER_GRACE_PERIOD_SEC`), and the cache all remain owned solely by `sequencer-check.ts`. No threshold/feed/grace re-derived in the route. |
| 2 | **Fail-safe preserved (down / grace / RPC-error → refuse; no fail-open)** | ✅ `isSequencerUp` (unchanged) returns `false` for hard-down (`answer===1n`), in-grace (`sinceStartedSec < SEQUENCER_GRACE_PERIOD_SEC`), and **RPC error** (`catch { up = false }`). The route refuses on `if (!seqUp)` with no fail-open branch. Note (defense alignment): `isSequencerUp` returns `true` for an unknown chain / no-feed chain, but that is unreachable here — unsupported chains are already rejected by the activation gate (400/409) and mainnet is skipped before the call (check #3). |
| 3 | **Mainnet byte-identical (chainId absent / 1 → 0 calls, test-pinned)** | ✅ Guard: `if (chainId != null && Number(chainId) !== DEFAULT_CHAIN_ID)`. Absent → skip; `chainId=1`/`"1"` → `Number()===DEFAULT_CHAIN_ID` → skip. No `isSequencerUp` call, no client construction on mainnet. Test "mainnet byte-identical" asserts both absent and `chainId=1` → 200 with `isSequencerUp` **not** called and `getPublicClientForChain` **not** called. |
| 4 | **Placement: after activation gate, before rate-limit + upstream** | ✅ Inserted at `route.ts:113`, immediately after the `if (chainId != null){ getChainStatus(...) }` activation block (~ln 98–111) and **before** the `[Audit B-06]` rate limiter and `fetchSwapFromSource`. Test "refuses … (before rate limit + upstream)" asserts `mockCheckRateLimit` **not** called and `mockFetchSwapFromSource` **not** called on a down sequencer — a refused request burns neither budget nor an upstream call. |
| 5 | **503 `{error, sequencerDown:true}` + `Retry-After:60` identical to quote gate (#167)** | ✅ Swap: `NextResponse.json({ error: seqErr.message, sequencerDown: true }, { status: 503, headers: { 'Retry-After': '60' } })` with `seqErr = new SequencerDownError(chainId)`. Quote (`quote/route.ts:190`): `{ error: err.message, sequencerDown: true }`, `503`, `Retry-After: 60` with the same `SequencerDownError`. Same body keys, same message source, same status, same header — byte-identical wire output. The swap path checks inline + constructs `SequencerDownError` only for the message (single-sourced wording); the quote path throws-and-catches — both produce identical output, and the prompt permitted either style. |

## Findings

| ID | Severity | file:line | Disposition | Description |
|----|----------|-----------|-------------|-------------|
| E2I01-I-01 | INFO | `route.ts` (refusal message) | REPORT | `SequencerDownError.message` reads "…quotes are paused until it stabilizes." On the swap-**build** path the refusal isn't strictly about quotes, but the wording is intentionally single-sourced so the client renders one unified "paused" UX. Acceptable; no change recommended (changing it would fork the message). |
| E2I01-I-02 | INFO | process (PR #170) | REPORT | Commit `3079d67` is already merged to `origin/main` at audit time. `main` ≠ prod, and the gate is additive + now audited 0C/0H, so no harm — but per rules #2/#3 a security-gate change ideally lands the Auditor pass before merge. Recorded as a process note, not a code defect. |

**No remediation prompts** — zero C/H/M/L; both notes are REPORT-only.

## Counter-sign
LIGHT Auditor: **APPROVED — 0C/0H**, cleared for prod promotion (security-gate pass per rules #2/#3).
In-session test re-execution required supplying the linux-arm64 rolldown binding (mounted `node_modules`
was built for macOS); CI on linux-x64 is the authoritative gate.
