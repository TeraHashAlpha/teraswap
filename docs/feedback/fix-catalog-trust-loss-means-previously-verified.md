# Feedback — fix/catalog-trust-loss-means-previously-verified

Regression found in the PRs produced by #525's `CONTINUITY_DROP_ON_TRUST_LOSS` policy: it dropped
any continuity seed with `inTrustedList === false` and `votes < minSources`, regardless of whether
that seed had ever been verified. Real runs (PRs #527/#529, chain 42161) show included 281 → 133:
153 of the dropped rows were NEVER verified (one-source bridge/continuity rows, always shown
unverified in the app, never audited by the guard). "not reaching" trust was misread as "LOST"
trust. Base lost 11 the same way (#526/#530).

- [x] C1 trust LOSS = previously verified, now not (`build-chain.ts`) + tests (a)/(b)/42161 replay
- [ ] C2 outage circuit breaker (fail-closed) + tests
- [ ] C3 one open catalog PR per chain (workflow)
- [ ] Evidence 1-4

## Evidence 1 — policy hunk + 42161 replay

`build-chain.ts:54` renames `CONTINUITY_DROP_ON_TRUST_LOSS` → `CONTINUITY_DROP_ON_VERIFIED_TRUST_LOSS`
(docblock rewritten to explain the regression). `:298-300` adds one guard line to the existing
drop loop: `if (!deps.previousCatalog?.get(addrLower)?.verified) continue` — a seed only drops when
its previous committed row had `verified: true`. No `previousCatalog` dep (older tests, or no prior
file) ⇒ nothing can be proven previously-verified ⇒ nothing in this loop is ever dropped (exact
pre-#525 behaviour restored for that case). `verified:true` already implies the row passed the
guard's trusted-list check at the time it was last built, so no separate previous-trust-verdict
store was wired in (would touch `trust.json`/`verdicts.ts`, both Do-NOT).

Stale comment references to the old constant name updated in `guard-gate.test.ts`, `types.ts`,
`build.ts` (grep-verified: `grep -rn CONTINUITY_DROP_ON_TRUST_LOSS` now only hits `curated.ts`,
out of the read/edit scope for this branch, left untouched).

**build-chain.test.ts 18 → 21** tests:
- (a) unchanged expectation (dropped, gate green) but now WITH a `previousCatalog` row carrying
  `verified: true` — without it the new code would keep this row, so the test would falsely pass
  the OLD (buggy) behaviour too. Rebuilt the fixture as a real delisting (both previously-agreeing
  sources run fine this run, stop listing the token) rather than a vote-count edit, so
  `retainFlakySeeds` (a different, unrelated fix) doesn't reclassify it as a flake.
- (a-never-verified) same fresh verdict as (a), NO `previousCatalog` dep at all ⇒ KEPT, not
  dropped, `trustLost: []`, `unverifiedSeeds: ['DAI']` (the pre-#525 honest-⚠ path).
- (a-never-verified-explicit) same, but WITH a `previousCatalog` row whose `verified` is itself
  `false` ⇒ same KEPT outcome — proves the check is on the previous row's `verified` flag, not
  merely presence/absence of `previousCatalog`.
- 42161-shape replay (new describe block, 1 test): synthesizes 128 previously-verified seeds
  (3-source agreement, stay healthy) + 153 previously-unverified seeds (1 curated-only "vote",
  losing `inTrustedList` this run — the exact regression shape) = 281 seeds, matching the CURRENT
  committed `token-catalog.42161.json` `counts` block (`{"included":281,"verified":128}`,
  read-verified on origin/main before any change this branch). Asserts `trustLost: []`, 281
  included, 128 verified, 153 `unverifiedSeeds` — **0 drops**.

Full run: `npx vitest run scripts/token-catalog/lib/build-chain.test.ts` → **21 passed (21)**.
`npx vitest run scripts/token-catalog/ src/lib/chains/catalog-address-guard.test.ts
src/lib/chains/catalog-guard.test.ts` → **122 passed (9 files)**. `npx tsc --noEmit` clean.
