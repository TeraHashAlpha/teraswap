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

## Round 2 — growth breaker, weekly cap, bounds, auto-merge (owner decision 2026-11-18)
Owner answers (asked once; they supersede the goal text): snapshot = rebuilt from the previous catalog's rows (only sizes are stored); cap clamped to size-bound room; Arbitrum `< 427`; auto-merge C4 stays 10, new C10.
1. **Step 0 (2026-11-18, live lists, previous = committed `counts.sourceCounts`):** 1inch 1074→3203 (+198%) / 194→337 (+74%) / 137→5069 (+3600%); every other source 95-100% of before. 1inch growth = long tail of real contracts: 60 sampled entries (20/chain, step-sampled, vs rows on the site) have bytecode 60/60; 8/20, 10/20, 6/20 also on CoinGecko; symbols are tokenized stocks (`…x`, `…on`, `…c`), vault wrappers (`stataBas…`, `waBas…`), `r…` wrappers. "New" is vs 1inch rows on the site (the old 1inch list is not stored), so 2477/200/4981 overstates. Rows built by the unchanged code: 1393 / 521 / 608 (prior session; chain 1 re-run today 1393); with this change 976 / 474 / 401 (real `tokens:sync`, scratch worktree, catalog never committed) and guard + size assertions green on them.
2. **Rules:** A `lib/source-growth.ts:40,59,71` + `lib/build-chain.ts:205-224` (held source → snapshot, recorded size kept) + accepted sizes in `scripts/token-catalog/accepted-source-sizes.json` (`"<chain>:<source>": <size>`, read in `build.ts:299`); B `lib/refresh-decision.ts:40,212,240` + `build.ts:335` (25 per chain, 7-day volume, clamped to `CATALOG_SIZE_BOUND` `lib/config.ts:98`); C `src/lib/chains/token-catalog.test.ts:229` (`< 427` = 389 committed + Base's 500−462=38; mainnet 6 / Base 38 differ, Base's chosen); D `auto-merge-eligibility.mjs:200` C10 (+ C3, C4) fed by `--decision-file` (`token-catalog-refresh.yml:356`); one `source growth held back` issue per chain (`refresh-issue.ts held`, workflow step `:412`).
3. **Sample PR body, Arbitrum, today's lists (real run):** removed 3 (LIQD, RGT, waArbezETH, each with guard reason), left out None; "Sources held back": `chain 42161 · oneinch · previous 137 → now 5069 entries (+3600%) · accept with "42161:oneinch": 5069`; held back by the cap: None (15 additions, under 25); 389→401 rows. Mainnet 994→976 (−18, +0), Base 462→474 (−1, +13). The cap did not bite on real data this week; it is covered by tests only.
4. **Tests:** `source-growth.test.ts` (exactly 50% / +1 entry, first appearance, no snapshot, accepted sizes, strict file), `additions-cap.test.ts`, `growth-and-cap.test.ts` (3 real cases rebuilt through `buildChainCatalog`; property seeds 1 2 3 7 42 99 1234 2026 31337 86400 × 3 chains, a coverage test proves held / used / cap / size-clamp / empty branches all ran), `size-bounds.test.ts`, `build-wiring.test.ts`, C10 + CLI tests, workflow wiring. Mutants (scratch copy) all killed: breaker removed (M7, M7b), `>=`, 60%, snapshot dropped, size reset, acceptance ignored; cap removed, 26, clamp removed, ascending rank, protected held, build.ts without cap/held/accepted (M8f survived until `build-wiring.test.ts`); C10 always true / unknown=0 / no decision file; bound drift. One existing assertion changed on purpose: PR-body heading count `2` → the exact list of the four headings (stricter).
5. **Verify:** `agent-verify` once at `12ad43c0` (load 4.9): suite 11198 pass, lint +0/+0, tsc 0, build ok, parity 123, rpc-budget 36; after the owner's merge of main (`a15d6d47`) + AGENTS.md re-pin: catalog + chains tests 691 pass, tsc 0, `check-agents-parity.mjs` OK. `diff --stat` since 3639e041 (own work, merge of main excluded) in the final report; code head `a15d6d47`, compare https://github.com/TeraHashAlpha/teraswap/compare/main...fix/catalog-refresh-drops-untrusted. **Not verified:** CI, the workflow YAML on a real runner, `refresh-issue.ts held` against real GitHub, CodeQL, keeper suite, a second full agent-verify after the merge, the cap on real volumes (never exceeded 25), 7-day volume lookups for the cap (CoinGecko 429s degrade to 24h order).
