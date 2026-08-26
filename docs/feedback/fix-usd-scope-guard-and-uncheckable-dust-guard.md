## Feedback — fix/usd-scope-guard-and-uncheckable-dust-guard

### Nine fixture results (one line)

1 namespace-import-of-usd DETECTED · 2 namespace-import-of-barrel+member DETECTED · 3 `export {} from` DETECTED
· 4 `export * from` DETECTED · 5 `require()` destructure DETECTED · 6 dynamic `import()` + member DETECTED ·
7 comment-only mention UNDETECTED · 8 unrelated name UNDETECTED · 9 barrel-for-other-names + comment-only
(DCAPanel.tsx's own shape) UNDETECTED — all nine as required, `usd-scope-guard.test.ts` green (5/5).

### Mutation proof (verbatim failure line)

Planted `import * as usd from '@/lib/order-engine/usd'` as the first import line of `DCAPanel.tsx`, ran the suite:

```
AssertionError: These modules import APPROX_PRICES/fillUsd but are not on the display-only allowlist.
If the import is a GATE or a SIGNING input it must read the live Chainlink → DefiLlama
price instead (see DCAPanel.livePriceIn). If it is genuinely display, add it to ALLOWED
with a comment saying why a stale estimate is harmless there:
components/DCAPanel.tsx: expected [ 'components/DCAPanel.tsx' ] to deeply equal []
```

(a second test, `the two modules this change moved OFF the table stay off it`, also failed on the same mutation:
`expected true to be false` for `components/DCAPanel.tsx`.) Reverted immediately after capturing the failure —
`git diff --stat src/components/DCAPanel.tsx` was empty before the real L-2 edits began, and the suite went back
to 5/5 green.

### Acceptance results

1. All nine fixtures behave as listed — PASS.
2. Mutation proof — PASS (failure line above, reverted, verified clean).
3. `DCAPanel.minchunk-uncheckable.test.tsx` (new, 3 tests): unpriced spend leg renders
   `dca-minchunk-uncheckable`; a priced default WETH leg does not; an oracle-blocked panel renders
   `dca-oracle-block` and not this notice, even though the spend leg is unpriced there too — PASS.
4. `npx tsc --noEmit` clean; `npx eslint` on the three changed files: 0 errors, 7 pre-existing
   `react-hooks/set-state-in-effect` warnings on lines this change did not touch; combined DCAPanel +
   usd-scope-guard suite (10 files, 90 tests) green — PASS.

### Edge case

- `applyDcaMinChunkGuard` (`src/lib/order-engine/dca-custom.ts`, out of scope for this PR) only ever runs
  inside `customMode` — the min-chunk dust guard is a Custom-mode-only feature; the preset branch never calls
  it. `minChunkUncheckable` is therefore gated on `customMode` too, matching exactly where the guard it stands
  in for would otherwise have run. An unpriced spend leg under the PRESET buy-count flow gets no notice, by
  design — there's nothing there for the notice to explain the absence of.
