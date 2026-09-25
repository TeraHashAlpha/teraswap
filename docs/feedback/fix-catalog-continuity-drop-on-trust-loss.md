# Feedback — fix/catalog-continuity-drop-on-trust-loss (issue #518)

- [x] C1 `curated.ts` REMOVALS += HANU + 4 tests — unblocks chain 1 now
- [ ] C2 `CONTINUITY_DROP_ON_TRUST_LOSS` in `build-chain.ts` + 4 tests + guard-gate test
- [ ] Evidence 1-3

## Evidence 1 — REMOVALS hunk + test
`curated.ts:30-39` adds `'1:0x72e5390edb7727e3d4e3436451dadaff675dbcc0'` to `REMOVALS` with the
sUSD/MV-style dated justification. One line covers BOTH paths: `applyCuratedCorrections`
(a stale upstream list cannot re-fetch it) and `correctSeed` → null (`build.ts:96-120 seedsFor`
runs every seed through it, so the continuity-seed path drops it too). `trust.json` untouched.
`curated.test.ts` +4 (`isCuratedRemoval` both cases, stale-list resurrection, seed path,
chain-scoping): **10 → 14 pass**.
