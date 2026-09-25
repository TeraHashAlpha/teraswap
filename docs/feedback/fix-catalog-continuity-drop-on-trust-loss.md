# Feedback — fix/catalog-continuity-drop-on-trust-loss (issue #518)

- [x] C1 `curated.ts` REMOVALS += HANU + 4 tests — unblocks chain 1 now
- [x] C2 `CONTINUITY_DROP_ON_TRUST_LOSS` in `build-chain.ts` + 6 tests + 2 guard-gate tests
- [x] Evidence 1-3

## Evidence 1 — REMOVALS hunk + test
`curated.ts:30-39` adds `'1:0x72e5390edb7727e3d4e3436451dadaff675dbcc0'` with the sUSD/MV-style dated
justification. One line covers BOTH paths: `applyCuratedCorrections` (a stale list cannot re-fetch it)
and `correctSeed` → null (`build.ts:96` `seedsFor` runs every seed through it). `trust.json` untouched.
`curated.test.ts` +4 (`isCuratedRemoval`, stale-list resurrection, seed path, chain-scoping): **10 → 14**.

## Evidence 2 — policy hunk + tests
`build-chain.ts:30-54` `CONTINUITY_DROP_ON_TRUST_LOSS` (grep-able) documents the rule and the five
deliberately-unchanged behaviours; `:259-294` applies it after the guard audit (needs the fresh
verdict) and before assemble: for each seed that is not a core and not in the new
`handCuratedSeeds` dep, `inTrustedList === false` + `externalVoteCount < config.minSources` ⇒ drop
from the seed map and from `conflictResult.kept`, push `report.trustLost`, log
`removed (trust lost: <reason>)`. `types.ts` `TrustLostSeed` + `BuildReport.trustLost`; `verify.ts:331`
initialises it; `build.ts:handCuratedSeedsFor` (DEFAULT_TOKENS + CURATED_BASE/ARBITRUM_SEEDS,
post-`correctSeed`) + a run-log block. **build-chain.test.ts 12 → 18**: (a) dropped+reported, gate
green; (b) NEW address still `guard-fatal`; (c) core still throws `CoreTokenValidationError`;
(d) ≥2 votes ⇒ kept; (e) hand-curated exempt; (f) `inTrustedList === null` ⇒ kept.
**guard-gate.test.ts 10 → 12**: trust loss is still fatal when audited; no fatal once the row is out
of the audited set (a stale verdict alone never reds the gate). Mutation-checked: commenting out
`dropped.add(addrLower)` fails (a) only.

## Evidence 3 — numbers
`git diff --stat origin/main`: 9 files, +297/-3. Suite **4194 → 4206 pass** (284 files, 0 fail;
+12 = 4+6+2). `tsc --noEmit` clean. Lint **94 warnings / 0 errors, delta 0** (measured in this
worktree at `origin/main` af2da77 and again at HEAD).

### Auditor note (gate-adjacent, strictly narrowing — no separate Auditor run)
**Stricter:** a continuity seed can now LEAVE. Nothing gained a way in.
**Byte-identical:** the trusted-list check itself (`catalog-guard.ts:139-143`), `verdicts.ts`, the
workflow, `trust.json`, `deriveGuardOutcomes` (`guard-gate.ts:18-61` — still fatal on
`inTrustedList === false`). No `trustedListExempt`/allowlist entry was added (Do-NOT rule #9).
**Unchanged by test, not by claim:** NEW address ⇒ fatal (b); cores forced, throwing loudly (c);
`null` ⇒ warn-only (f); hand-curated pinned (e); REMOVALS win (C1 tests).
**Residual freeze path, by design (d):** a seed that loses its listing while ≥2 external lists still
carry it is KEPT and still reds the gate — that case wants a human (exempt entry or REMOVAL), not an
automatic drop. Chain 1 would freeze again on such a token; the log line names it immediately.

### Scope deviation
`build.ts`, `types.ts`, `verify.ts` were not in the read list but had to change: `build-chain.ts` is
chain-agnostic and DI-only, so "hand-curated" cannot be derived there — `handCuratedSeedsFor` lives in
`build.ts` (which already owns `seedsFor`) and arrives as an optional dep. `report.trustLost` needs the
type and its initialiser. HANU stays in the committed `token-catalog.1.json` until the next refresh
regenerates it (no live run here, as instructed) — expected, and the reason PR #507 waits on that run.
