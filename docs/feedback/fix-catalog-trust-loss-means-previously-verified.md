# Feedback — fix/catalog-trust-loss-means-previously-verified

Regression found in the PRs produced by #525's `CONTINUITY_DROP_ON_TRUST_LOSS` policy: it dropped
any continuity seed with `inTrustedList === false` and `votes < minSources`, regardless of whether
that seed had ever been verified. Real runs (PRs #527/#529, chain 42161) show included 281 → 133:
153 of the dropped rows were NEVER verified (one-source bridge/continuity rows, always shown
unverified in the app, never audited by the guard). "not reaching" trust was misread as "LOST"
trust. Base lost 11 the same way (#526/#530).

- [x] C1 trust LOSS = previously verified, now not (`build-chain.ts`) + tests (a)/(b)/42161 replay
- [x] C2 outage circuit breaker (fail-closed) + tests
- [x] C3 one open catalog PR per chain (workflow)
- [ ] Evidence 4 (final numbers + Auditor note)

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

## Evidence 2 — outage circuit breaker hunks + tests

`types.ts`: `SourceCounts` (`Partial<Record<SourceId, number>>`) + `OutageSuspectedError` (same
fail-closed shape as `CoreTokenValidationError`). `build-chain.ts`: three named constants
(`SOURCE_OUTAGE_RATIO_THRESHOLD = 0.7`, `TRUST_LOSS_DROP_ABS_FLOOR = 5`,
`TRUST_LOSS_DROP_PCT_THRESHOLD = 0.05`). Two checkpoints:
- **1b, before assembling** (right after step-1 fetch, before seeds join the pool): this run's
  per-source `entries.length` (fulfilled fetches only) vs `deps.previousSourceCounts` — a source
  absent from `sourceCounts` this run (rejected fetch OR simply not attempted) naturally compares
  as 0, so no separate "which source rejected" tagging was needed (fetch-sources.ts untouched, as
  required). `< 70% of previous` or `=== 0` (with a >0 previous baseline) ⇒ throw before any
  merge/cross-verify/guard/verdict-collection work happens — also skips the network-heavy verdict
  collector on a suspected-outage run. No baseline for a given source (first run, or a brand-new
  source) ⇒ that source is skipped (record only).
- **7b, after assembling**: `trustLost.length > max(5, ceil(0.05 * deps.seeds.size))` ⇒ throw —
  catches the case where Commit 1's narrower, correctly-scoped policy still fires an implausible
  number of times (e.g. the trusted-list source itself is what's actually down).

Both throw `OutageSuspectedError`; `buildChainCatalog` never catches its own throw, so (same as
today's `CoreTokenValidationError` for a core) the promise rejects, the per-chain loop in
`build.ts` never reaches its `fs.writeFileSync` for that chain, and `run().catch` exits non-zero.

`build.ts`: `previousSourceCountsFor(chainId)` reads `counts.sourceCounts` straight off the
COMMITTED JSON file on disk (`token-catalog.generated.ts`'s `GeneratedToken` import surface only
re-exports `tokens`, not `counts` — confirmed by reading it, not guessed); wired into
`buildChainCatalog`'s new `previousSourceCounts` dep. `result.sourceCounts` is written back into
the payload as `counts.sourceCounts` so next run has a baseline. `run().catch` now also prints one
`::error::<label>: <message>` line (label distinguishes `catalog outage breaker tripped` from
`catalog build failed` via `instanceof OutageSuspectedError`) — GitHub Actions run-summary
annotation, independent of any separate alerting wiring (goal explicitly said not to depend on
that).

**build-chain.test.ts 21 → 29** tests (2 new describe blocks, 8 tests): source-count collapse
(below-ratio throws; exactly-0 throws with the literal `50→0` message; a fully-rejected fetch
compares as 0 and throws; at-or-above-ratio does NOT throw; no-baseline-first-run records counts
and compares nothing) + trust-loss volume (beyond-threshold throws; AT-threshold, computed from
the real constants not a hardcoded duplicate, does NOT throw; the baseline-first-run case — no
`previousCatalog` at all, so 0 rows are provably previously-verified, so 0 drops, so the breaker
never even evaluates).

Full run: `npx vitest run scripts/token-catalog/lib/build-chain.test.ts` → **29 passed (29)**.
`npx vitest run scripts/token-catalog/ src/lib/chains/catalog-address-guard.test.ts
src/lib/chains/catalog-guard.test.ts` → **130 passed (9 files)**. `npx tsc --noEmit` clean.
`npx eslint .` (full repo) → **94 warnings / 0 errors** — same baseline CLAUDE.md records for
origin/main (delta 0).

## Evidence 3 — workflow hunk + actionlint

`.github/workflows/token-catalog-refresh.yml`, "Open a PR when this chain's catalog changed" step
(only step touched, as scoped): before `git checkout -b "$BRANCH"` / `gh pr create`, lists every
OPEN PR whose `headRefName` starts with `chore/token-catalog-refresh-${CHAIN}-` (`gh pr list --json
number,headRefName --jq 'select(...| startswith(...))'`) and closes each with `gh pr close ...
--comment "Superseded by the ${TODAY} refresh for chain ${CHAIN}"` — branches are never deleted
(repo convention). `$TODAY` is computed once and reused for both the branch name and the comment
(previously `$(date ...)` was inlined only into `BRANCH`). All new interpolation is through
`CHAIN`/`TODAY`/`PREFIX` shell variables set from the step's existing `env:` block (`CHAIN`) or
computed in-script — nothing new spliced from `${{ }}` template context into the script body
except `${{ github.repository }}` / `${{ github.token }}`, both pre-existing patterns in this same
file (neither is attacker-controllable — static repo identity / the job's own token).

Only runs when the gate passed AND this chain's catalog actually changed this run (after the
existing early-`exit 0`) — a no-op refresh never touches unrelated open PRs for other dates.

`actionlint` (installed via `brew install actionlint` for this check — not present in the repo
before): both `actionlint .github/workflows/token-catalog-refresh.yml` and a full `actionlint`
(all workflows) exit **0, no findings**.

## Evidence 4 — final numbers
