# fix/portfolio-tokens-view

Goal: a catalog token the wallet holds is never missing from Portfolio (C1); small balances and junk hidden by default, v1 == v2 (C2).
- [x] C1 paging + catalog first + `truncated` + note  - [x] C2 view  - [x] evidence 1-4 below

## 1. Cause, fix, compute units
- Cause: `route.ts` made ONE `alchemy_getTokenBalances [address,'erc20']` call, never read `pageKey` (old `:210`), then `.slice(0, MAX_TOKENS)`
  in Alchemy's order (old `:221`). Also: the old filter kept the 32-byte zero hex as non-zero (the docs example shows exactly that value).
- Fix: follow `pageKey` (<= 5 pages of 100, 8 s budget; a failing page 2+ keeps what was read). If the scan did not reach the end, ONE batched
  check of the chain's catalog addresses (ETH 993 = 10 calls, Base 461 = 5, Arb 388 = 4). Trim ranks curated > full catalog > unknown.
  `{ tokens, truncated }`; hook + v1 + v2 show a quiet note.
- Docs, re-read by me on the live pages 2026-11-12 (curl, not only the subagent): CU table rows `alchemy_getTokenBalances 20`,
  `alchemy_getTokenMetadata 10`, OpenAPI `x-compute-units: 20`, `maxCount` "capped at 100". The subagent's contrary summary of the page tail was wrong.
  `pageKey` appears ONLY as a request option; the response example/schema show none. No key here (`ALCHEMY_API_KEY` unset), so not checkable live.
  Conservative reading (commit 6c2ce05): a last page with no key AND < 100 entries proves the end; a FULL page with no key does not, so the
  catalog check runs and `truncated` is set. Worst-case CU below already includes that check.

| per request (CU) | before | after |
|---|---|---|
| wallet on one page | 20 | 20 |
| worst, scan completes | 20 + 200x10 = 2,020 | 5x20 + 200x10 = 2,100 |
| worst, cap hit or full last page | 2,020 | 100 + check + 2,000 = 2,300 ETH / 2,200 Base / 2,180 Arb |
| per IP per minute (5/min, unchanged) | 10,100 | 11,500 / 11,000 / 10,900 |

## 2. Tests
`route.paging.test.ts` (8): 300 junk then UNI on the next page, and UNI on page 3 of 298 junk -> UNI first, catalog; cap -> 5 pages, `truncated`,
catalog check finds UNI; page-2 error -> page 1 served; full last page without key -> check + `truncated`; one page -> 1 call; padded zero; page-1 502.
Also `usePortfolio.test.ts`, `portfolio-truncated.test.tsx`, `portfolio-view.test.tsx` (20). Old route fails 5 of the first 6.

## 3. Frames (all 12 viewed)
Mocked-wallet rig `src/ui/v2/__tests__/mobile/rig.ts`, two prod builds (origin/main vs head), Base, 40 junk tokens. Before = the old route's answer
(no UNI): raw "t.me/s/us_pool" + emoji rows, total $6.00. After = new answer: ETH, WETH, UNI by default, "Show all tokens (41 hidden)", total $571.92;
open: "Hide small balances", flagged names read "Unverified token" + short address + third-party line. v1 and v2 agree at 1440 and 375.
`~/ts-worktrees/portfolio-tokens-view-frames/{before,after}-{v1,v2}-{1440,375}[-open].png` (outside the repo). Unflagged junk ("Ether Gift Token") shows as is.

## 4. Verify on code head 6c2ce05 (only this file changes after it): `agent-verify.sh --codeql` RESULT PASS
suite 10406/0 (474 files) · lint +0/+0 · tsc 0 · build ok · parity 111 · rpc-budget 33 · CodeQL 13 vs 13, 0 new · `gen-claude-state --check` current.
19 files, +1034 / -119. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/portfolio-tokens-view (no PR, CI not polled).

## Decisions
Total value = the hook's `totalValueUsd` (sum of every priced holding), untouched by the view. "Catalog" = full verified catalog or curated list
(imports are not). Masks zero-width/bidi characters too; domain rule is generic so "ether.fi ..." masks (fixtures renamed). Skeleton, not "all hidden",
until prices land. Old tests changed on purpose (UNK $5, SPAM -> ETHFI). `groupPortfolio` now unused (kept). Route keeps plain `checkRateLimit`
(api/CLAUDE.md prefers `Within`; numbers frozen). `goal-lint` FAILs only on the missing `CONTROL:` line of the goal text.
