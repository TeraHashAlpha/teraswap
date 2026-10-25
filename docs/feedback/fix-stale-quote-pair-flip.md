# Feedback — fix/stale-quote-pair-flip (recon 58)

Goal: quote carries identity; stale quotes never render; guard two-sided; flip request + Base USDC badge.
No PR (owner opens). No change to useSwap, /api/swap, calldata, minimumOutput derivation, QUOTE_RATE_LIMIT, poll interval, copy.

## Checklist
- [x] C1 useQuote tags `meta` with identity; setMeta only on key match + !aborted; clear on flip/token/chain change; SwapBox uses quote's decimalsOut; gates read key-matching quote only
- [x] C2 /api/quote echoes tokenIn/tokenOut/chainId/decimalsIn/decimalsOut/amountIn; client keys from echo
- [ ] C3 assertSwapConsistentWithQuote two-sided + pair/chain mismatch refusal
- [ ] C4 flip skips immediate refetch while debounce pending; TokenAddressBadge uses useQuoteChainId
- [ ] Verify: suite vs origin/main (312 files / 4880 tests, lint 93 warn), tsc, diff --stat, push, compare link

## Baseline (origin/main 3a97f76)
312 files / 4880 tests pass; eslint 93 warnings, 0 errors.

## Scope record
Reads outside the list: `src/lib/adapters/types.ts` (MetaQuoteResult shape, ~15 lines); grep-only for call sites of
`useQuote`, `assertSwapConsistentWithQuote`, `selectBestWithMevPreference`/`scopeToExecutable` locations.
Out-of-list EDIT (forced): `src/components/DigitRoller.test.tsx` — its SwapBox fixture mocks `useQuote` with a quote that has no
identity; fail-closed SwapBox now (correctly) shows no quote, so one fixture line (identity) was added. No assertion changed.
