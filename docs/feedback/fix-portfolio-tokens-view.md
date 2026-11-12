# fix/portfolio-tokens-view

Goal: a catalog token the wallet holds is never missing from Portfolio (commit 1); small balances and junk hidden by default, v1 == v2 (commit 2).

- [x] C1 route: follow `pageKey`, catalog first on trim, `truncated`, UI note (v1 + v2)
- [ ] C2 default view: >= $1.00, one control, order by USD, junk names masked, third-party line
- [ ] Evidence 3 (frames 1440 / 375, v1 + v2) and 4 (verify, diff --stat, compare link)

## 1. Cause and fix (evidence 1)
- Confirmed: `route.ts` made ONE `alchemy_getTokenBalances [address,'erc20']` call, never read `pageKey` (old `:210`), then
  `.slice(0, MAX_TOKENS)` in Alchemy's order (old `:221`). Docs: `maxCount` is "capped at 100" per call. UNI was on a later page.
- Also found: old filter kept the 32-byte zero hex (`0x000..0`) as non-zero; new `isNonZero` drops it (zero rows no longer take slots or metadata calls).
- Fix: follow `pageKey` (<= 5 pages of 100, 8 s budget); a failing page 2+ keeps what was read. If the scan did not reach the end, ONE
  batched check of the chain's catalog addresses (chunks of 100, native sentinel excluded). Trim ranks curated, then full catalog, then unknown.
  Catalog-only holdings take name/logo from the catalog (no metadata call). Response `{ tokens, truncated }`; hook + both UIs show a quiet note.
- Compute units (docs: `alchemy_getTokenBalances` 20 CU, `alchemy_getTokenMetadata` 10 CU; no per-form breakdown, address-array form assumed 20):

| per request | before | after |
|---|---|---|
| wallet on one page, no unknowns | 20 | 20 |
| worst, scan completes | 20 + 200x10 = 2,020 | 5x20 + 200x10 = 2,100 |
| worst, page cap hit (check runs) | 2,020 | 100 + check + 2,000 = 2,300 (ETH, 10 chunks) / 2,200 (Base, 5) / 2,180 (Arb, 4) |
| per IP per minute (5 req/min, unchanged) | 10,100 | 11,500 / 11,000 / 10,900 |

## 2. Tests (evidence 2) `route.paging.test.ts`, `usePortfolio.test.ts`, `portfolio-truncated.test.tsx`
300 junk then UNI on page 3 -> UNI first, `isDefault`; cap reached -> 5 pages, `truncated`, UNI found by the catalog check; page 2 error -> page 1
served; one-page wallet -> 1 call, `truncated:false`; padded zero dropped; page 1 error -> 502. 5 of 6 fail on the old route.

## Notes
- `goal-lint` FAILs only on the missing `CONTROL:` first line of the owner's goal text; left as given.
- Not changed (out of scope): the route still uses plain `checkRateLimit` (api/CLAUDE.md prefers `checkRateLimitWithin`); numbers 5/min untouched.
- The docs response schema lists no `pageKey` field; the route reads `result.pageKey` (the documented request option's counterpart). Unverified live.
