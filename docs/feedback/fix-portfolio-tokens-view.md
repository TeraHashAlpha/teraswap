# fix/portfolio-tokens-view

Goal: a catalog token the wallet holds is never missing from Portfolio (C1); small balances and junk hidden by default, v1 == v2 (C2).

- [x] C1 route: follow `pageKey`, catalog first on trim, `truncated`, UI note (v1 + v2)
- [x] C2 default view >= $1.00, one control, order by USD, junk names masked, third-party line
- [x] Evidence 3 (frames) and 4 (verify, diff --stat, compare link): see the end

## 1. Cause and fix (evidence 1)
- Confirmed: `route.ts` made ONE `alchemy_getTokenBalances [address,'erc20']` call, never read `pageKey` (old `:210`), then
  `.slice(0, MAX_TOKENS)` in Alchemy's order (old `:221`). Docs: `maxCount` is "capped at 100". UNI sat on a later page.
- Also found: the old filter kept the 32-byte zero hex (`0x00..0`) as non-zero; `isNonZero` now drops it (no slot, no metadata call).
- Fix: follow `pageKey` (<= 5 pages of 100, 8 s budget); a failing page 2+ keeps what was read. If the scan did not reach the end, ONE
  batched check of the chain's catalog addresses (chunks of 100, native sentinel excluded: ETH 993 addr = 10 calls, Base 461 = 5, Arb 388 = 4).
  Trim ranks curated, then full catalog, then unknown. Catalog-only holdings use catalog name/logo (no metadata call). `{ tokens, truncated }`.
- Compute units (docs: `alchemy_getTokenBalances` 20 CU, `alchemy_getTokenMetadata` 10 CU; no per-form breakdown, array form assumed 20):

| per request | before | after |
|---|---|---|
| wallet on one page, no unknowns | 20 | 20 |
| worst, scan completes | 20 + 200x10 = 2,020 | 5x20 + 200x10 = 2,100 |
| worst, page cap hit (check runs) | 2,020 | 100 + check + 2,000 = 2,300 ETH / 2,200 Base / 2,180 Arb |
| per IP per minute (5 req/min, unchanged) | 10,100 | 11,500 ETH / 11,000 Base / 10,900 Arb |

## 2. Tests (evidence 2)
`route.paging.test.ts` (5 of 6 fail on the old route): 300 junk then UNI on page 3 -> UNI first, `isDefault`, `truncated`; cap reached -> 5 pages,
`truncated`, UNI found by the catalog check; page 2 error -> page 1 served; one-page wallet -> 1 call, `truncated:false`; padded zero dropped;
page 1 error -> 502. Also `usePortfolio.test.ts`, `portfolio-truncated.test.tsx`, `portfolio-view.test.tsx` (20: $0.80/$0.99/unpriced hidden,
$1.00 shown, order, junk example has no t.me/claim/visit/emoji/link open or closed, all-hidden, v1 == v2 text, no U+2014).

## Decisions and notes
- Total value: unchanged, `totalValueUsd` in `usePortfolio` = sum of `valueUsd` over EVERY priced holding; the view only filters rows.
- Defined "catalog" = the chain's full verified catalog (`getFullCatalog`) or curated list; session imports are not catalog. Masking also treats a
  zero-width/bidi character as junk (my addition, masks more only). Domain rule is generic (`label.tld`), so "ether.fi ..." masks; fixtures renamed.
- While prices have not landed (`isLoading && lastUpdated === null`) both UIs show the skeleton, not a false "all hidden". With a price error the
  note "No token ... worth $1.00" can read wrong beside the error banner. Chain switch with stale `lastUpdated` can flash it for one tick.
- Existing tests changed on purpose: UNK fixture $0.50 -> $5, USDC/SPAM rows need the control, ETHFI replaces SPAM in the import test.
- `portfolio-model.groupPortfolio` is now unused (kept, annotated). Route still uses plain `checkRateLimit` (api/CLAUDE.md prefers `Within`); not touched.
- Docs list no `pageKey` field in the response schema; the route reads `result.pageKey`. Unverified live. `goal-lint` FAILs only on the missing `CONTROL:` line.
- Evidence 3 uses the mocked-wallet rig of `src/ui/v2/__tests__/mobile/rig.ts` on two prod builds (origin/main vs head), Base, 40 junk tokens.
  Before = the old route's answer for the owner's wallet (no UNI); after = the new answer (UNI present). Frames, outside the repo:
  `~/ts-worktrees/portfolio-tokens-view-frames/{before,after}-{v1,v2}-{1440,375}[-open].png`.

## 4. Verify (evidence 4), `scripts/agent-verify.sh --codeql` on the head: RESULT PASS
suite 10404 passed / 0 failed (474 files) · lint +0 err +0 warn · tsc 0 · build ok · v1v2-parity 111 · rpc-budget 33 · CodeQL 13 vs 13, 0 new ·
`gen-claude-state.mjs --check` current (test-file count regenerated, AGENTS.md re-pinned). 19 files, +994 / -119.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/portfolio-tokens-view (no PR opened, CI not polled).
