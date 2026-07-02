# AUDIT-W4-router-allowlist-parity — single-source router allowlist + parity test + stale comment (W4-I-01/I-02, INFO)

> **Source:** T-SAF campaign 2026-07-01, Wave 4 (chain-awareness APPROVED 0C/0H on production `cb0748d`). Both are
> INFO / defense-in-depth — **not blocking**. No contract change, no deploy. SSH-signed (noreply committer). RICE:
> low effort, and I-02 auto-catches the #1 historical defect class (Augustus V5/V6 chain drift) → worth doing.

## Context
Wave 4 confirmed router selection is chain-correct in production (mainnet OrderExecutor → Augustus V5; Base → V6 —
the on-chain mirror; a name-based "V5→V6 everywhere" change would break mainnet). Two hygiene findings:
- **W4-I-01 (INFO):** a **stale comment** at `src/lib/.../api.ts:540` says the path is "mainnet-pinned" — the code is
  already chain-aware. Misleading to a future reader.
- **W4-I-02 (INFO):** the router allowlist is expressed in **three separate places** for different paths → **drift
  risk** (one gets updated, another doesn't → a chain-awareness regression like the historical Augustus bug). No
  single source of truth, no test that the frontend allowlist matches the on-chain OrderExecutor whitelist per chain.

## Objective
Remove the misleading comment, and make the router allowlist **drift-proof**: one source of truth + a test that the
frontend/config allowlist is a **subset of the on-chain OrderExecutor `whitelistedRouters` per chain**.

## Requirements
1. **W4-I-01:** fix the stale comment at `api.ts:540` (and grep for other "mainnet-pinned"/"mainnet only" comments
   on now-chain-aware paths) to reflect the chain-aware reality. Comment-only; no logic change.
2. **W4-I-02 — single source:** consolidate the three router allowlists into ONE canonical per-chain source (a
   single exported map/config), and have the other call sites import it — no duplicated literals.
3. **W4-I-02 — parity test:** add a test asserting, **per chain**, that the frontend/config router allowlist is a
   **subset of the on-chain `whitelistedRouters`** of that chain's OrderExecutor (mainnet `0xeFC3` → Augustus V5 /
   1inch V6 / … ; Base `0x135B` → Augustus V6 / …). Use a committed on-chain snapshot (like the catalog-guard's
   zero-network verdict cache, refreshable) so the test is **not flaky**; a router in the frontend list but NOT on
   the OE whitelist for that chain → **FAIL**. This makes a future Augustus V5/V6-style chain drift caught in CI.
4. Keep it chain-scoped: the parity check runs for **each** supported chain (1 + 8453), never cross-chain.

## Do NOT
- No contract change, no deploy, no allowlist widening. Do NOT make the parity test hit live RPC on every CI run
  (use a committed, refreshable snapshot). Do NOT change the actual router selection logic (it's correct — this
  only de-duplicates + guards it).

## Files affected (verify on main)
- The stale comment (`api.ts:540` + any siblings). The three router-allowlist locations → one canonical source.
  A new parity test + its committed on-chain-whitelist snapshot (mirror the catalog-guard pattern).

## Expected output
- Branch off latest `origin/main`; SSH-signed; CI green (incl. the new parity test). Comment corrected; one
  canonical router allowlist; the parity test FAILS if the frontend list drifts from the on-chain OE whitelist per
  chain. FEEDBACK notes which three locations were unified + the snapshot's refresh command.

## Quality criteria
No misleading "mainnet-pinned" comment on a chain-aware path; a single router-allowlist source of truth; a
non-flaky CI test that catches any frontend-vs-on-chain router-whitelist drift per chain (auto-guarding the #1
historical defect class); no logic or contract change.
