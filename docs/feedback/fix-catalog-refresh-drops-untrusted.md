# Feedback — fix/catalog-refresh-drops-untrusted

Goal: one untrusted token must not block a chain's weekly refresh (issues #700, #703, #706). The guard is untouched. Tables: `fix-catalog-refresh-drops-untrusted.tables.md`.

## Checklist
- [x] Step 0 classified, 3 failures reproduced with the workflow's commands
- [x] pure decision module + tests (real cases, 10 seeds, cap boundaries, dead list)
- [x] `tokens:sync` wired; PR-body sections; blocked chain changes nothing
- [x] issues: close on pass, exact-title, never a second open issue
- [x] guard diff empty; mutation proof; agent-verify once (load 7.5)

## 1. Step 0
All 18 are tokens already on the site (none new): 9 curated-only `verified:false`, 9 `verified:true` with >= 2 non-CoinGecko votes. All were in the previous CoinGecko list (trust fixture `inTrustedList=true`) and are absent from today's fresh one (list 88-98% of last run, so a real delisting, not an outage). Bytecode and on-chain symbol OK for all 18. CoinGecko has no coin id for any of them now, so 7-day volume is n/a (24h on site: FRM $46.87, rest 0/null). Not cores, not hand-pinned. Root cause: the pipeline keeps curated-only rows and rows with >= 2 votes ("a human decides"), the guard then reds the gate.

## 2. Sample PR body
17 lines for chain 1 (15 + DELTA, WHITE which the old pipeline dropped silently); full text in the tables file §4. Opens with `## Tokens removed from the site by this refresh`, then `## Candidates left out`.

## 3. Tests
`refresh-decision.test.ts` 57, `issue-plan.test.ts` 5, `refresh-workflow.test.ts` 6. Real cases chain 1 / 8453 / 42161: refresh passes, removed list exact, guard (`auditChain`) green on the result. Seeds 1 2 3 7 42 99 1234 2026 31337 86400. Mutants M1-M6 (+M3b) all killed (tables §5). Guard diff vs origin/main: empty (0 bytes) for the guard test, `catalog-guard.ts`, allowlist.

## 4. Workflow diff
PR body now starts with the sections file (missing file stops the PR); alert reads `blocked.<chain>.txt` and uses `refresh-issue.ts alert` (exact-title list, no fuzzy search, a failed lookup creates nothing); new step before the alert, `if: success()`, runs `refresh-issue.ts close` with the run URL. Gate step unchanged. Removal PRs fail auto-merge condition C3 (0 removals) so they get `catalog-review`: the owner's merge is the decision.

## 5. Verify
`agent-verify` once, clean worktree at 49b489d5: suite 11093 pass, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36 (CodeQL, keeper not requested: no app/keeper code touched). Head SHA, `diff --stat` and compare link: in the final report. Later commits only touch docs.

## Concerns (not fixed, owner's call)
- **Second blocker.** 1inch lists grew (1: 1074 -> 3205, Base 194 -> 337, Arbitrum 137 -> 5069) since the 11-16 run. Chain 1 builds 1377+ rows and Base 520+, both over the `token-catalog.test.ts` bounds (< 1000, < 500). After this fix chains 1 and 8453 still fail at that assertion (not loosened); 42161 passes. The outage breaker only catches a shrinking source.
- Protected (core / hand-pinned) token failing the guard blocks the chain instead of being removed (my reading; builds already throw for cores).
- 7-day volume is best-effort: `fetchCoinsList` memoises a 429 for the process, so a throttled run prints n/a (never a made-up number).
- Cap counts every removal (guard-fatal + pipeline drops), so chain 1 today is 17 of 20.

## NOT verified
CI, the workflow YAML on a real runner, `refresh-issue.ts` against real GitHub (only the pure plan is tested), CodeQL, keeper suite. Base / 42161 were checked by replaying the decision on the real old-pipeline output, not by a second full new-pipeline run.
