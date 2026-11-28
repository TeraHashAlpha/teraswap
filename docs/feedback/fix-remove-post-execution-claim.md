# fix/remove-post-execution-claim (owner decision 2026-11-28)

## Checklist
- [x] Guard test, red on the old copy
- [x] Claims module: check list 6 -> 5, stage wording out of the figure
- [x] v1 and v2 landing: stat, caption, card, paragraph
- [x] Pinned expectations updated
- [x] Screenshots, v1 and v2, desktop and phone
- [x] `scripts/agent-verify.sh` (two runs, below), evidence, push

## Evidence (before line = origin/main, after line = ac510f93)
1. Hero, v1 `LandingPage.tsx:328` `VERIFICATION CHECKS · 2 STAGES`, 6 -> `:326` `VERIFICATION CHECKS`, 5. v2 `slots.ts:26-30` -> `:25`, same.
2. v1 `LandingBelowFold.tsx:549` "Post-execution verified ✓ Verified" removed (grid `:664` 3 columns -> `:648` 2); `:645-658` POST-SWAP card and paragraph removed.
3. v2 `slots.ts:49` figure removed (bar 4 -> 3 cells, `Sections.tsx:168` -> `:162`); `Sections.tsx:126-130` card removed (list `:155` 2 columns -> `:149` 1).
4. `product-claims.ts` `:294-301` stages, `:325` 6th check, `:308-313` + `:338` 2% number, `:439` drift check: removed. Docs v1/v2 and `public/`: no such wording. Renames: none. Gone: `VERIFICATION_STAGES`, `VerificationStage`, `.stage`, `VERIFICATION_STAGE_COUNT`, `VERIFICATION_SUMMARY`, `POST_EXECUTION_SHORTFALL_WARN(_PCT)`.
5. Replacement sentence: none added.
6. CHANGED EXPECTATIONS: CHECKS 6 -> 5, NOW PINNED BY ID. HERO CAPTION `... · 2 STAGES` (MOCK `3 STAGES`) -> `VERIFICATION CHECKS`, NO "STAGE" ON v1. v2 BAR 4 CELLS -> 3 (`[11,13,5,null]` -> `[11,13,5]`). v2 REVEAL ORDER `[0,0,0,1,2]` -> `[0,0,0,1]`.
7. CHANGED EXPECTATIONS: "SHORTFALL ABOVE 2%" PRESENT -> ABSENT. ADDED: "✓ Verified" ABSENT. REMOVED: TWO-STAGE TESTS, "AUTO-DISABLED + P0 IS BACKED BY THE VALIDATOR" TEST, 2% DRIFT TEST, `VERIFICATION_STAGES` IN 2 MOCKS, NUMERAL SLOT `3` FOR STAGES (`3` STAYS ALLOWED FOR "3-way").
8. Guard `src/ui/v2/__tests__/no-post-execution-claim.test.tsx` (11 tests): pins zero callers; while zero, reads UI strings (not comments) and `public/`, renders both landings and Docs. Red on old copy; red with the old v2 card + claims module put back, and with a probe import.
9. Run 1, `770e42f2`, load 7.02: FAIL, one test, in suite (12314 pass, 1 fail) and v1v2-parity (122, 1): `isolation.test.ts`, because my guard sat in `src/config/` and referenced ui/v2. Fix `ac510f93` moves it; that test is unchanged.
10. Run 2, `ac510f93`, load 9.70, base `f0437026`: PASS. suite 12315/0 (583 files), lint-delta +0/+0, tsc, build, v1-css, v1v2-parity 123/0, rpc-budget 36/0.
11. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/remove-post-execution-claim
12. NOT verified: CI; CodeQL (not requested); production (never called, "secret unset" is the goal's statement); real devices, Safari, Firefox.
13. 8 screenshots in `fix-remove-post-execution-claim/`: local `next dev`, `/api` stubbed (quote reads "Unavailable"), fixed header and dev badge hidden, installed Chromium 1248 (lockfile wants 1255; nothing installed). Taken before the rebase, which touched no file I changed. Horizontal overflow 0 px.
14. Premise: held. Mid-goal, PR #736 merged and closed the route (404, no longer imports the validator). Branch rebased before any push; `770e42f2` made the guard count any import.
15. Left as is, owner's call: Docs "protect users at every stage of a trade" (`DocsPage.tsx:413`, `DocsTabV2.tsx:383`) names no after-swap check. Repo docs (not the site) still describe it: `docs/TERASWAP-TECHNICAL-OVERVIEW.md:250-268,492`, `ROADMAP.md:72`.

## Further reads and notes
- Beyond the goal's list: repo-wide wording searches; `LandingPage.test.tsx`, `content-parity.docs.test.tsx`, `vitest.config.ts`, the two repo docs in line 15,
  the `validate-execution` route and validator diff after #736, `agent-verify.sh` (header), `isolation.test.ts` output, search hits in `proxy.ts` and
  `wagmiConfig.ts`, the `AGENTS.md` block that `next dev` wrote (restored, not committed), the `run-goal` skill and two agent memory notes on the browser rig.
- `scripts/goal-lint.mjs` (a `run-goal` step) was not run: the goal was already active.
- Test gap in my own pre-verify pass: I ran the v2 subfolders but not `src/ui/v2/isolation.test.ts`; run 1 caught it.
