# SPRINT-9W — Chain-aware wrapped-native in the CoW adapter (Base MEV-protection fix)

## Symptom (prod, Base)
"Force MEV Protection" on Base with a native-ETH sell → "No MEV-protected quote available. CoW
Protocol may be temporarily unavailable." / NO QUOTES AVAILABLE. Pre-existing (P217-era), NOT a 9T
regression — explains the historic "cowswap breaker open on Base".

## Root cause (confirmed in code)
`src/lib/adapters/cow.ts` lines ~174-175 and ~221-222 map native ETH to the GLOBAL `WETH_ADDRESS`
(mainnet `0xC02a…6Cc2`) before querying the orderbook. On Base the request goes to the Base orderbook
(`api.cow.fi/base/api/v1` — chain-aware since P217) but asks for MAINNET WETH, which doesn't exist
there → quote rejected → no MEV-protected quote, breaker accumulates failures.

## Fix
1. Add (or reuse, if present) a chain-aware `getWrappedNative(chainId)` in the chains registry —
   mainnet → `0xC02a…6Cc2`, Base → `0x4200000000000000000000000000000000000006` (already in the Base
   catalog; cross-check against the catalog entry, don't duplicate a hardcode).
2. Use it at BOTH cow.ts mapping sites (quote + order build) with the call's `chainId`.
3. **Sweep:** grep `WETH_ADDRESS` across `src/lib/adapters/**` and `src/lib/**` — fix EVERY site that
   maps native→wrapped for a per-chain request the same way (report any other chain-pinned uses in
   FEEDBACK even if out of scope).
4. Receiving native ETH from CoW (buyToken mapping, line ~175/~222): same chain-aware mapping; confirm
   the unwrap/receive path (if any) is chain-correct.

## Tests (TDD)
- Base native-ETH sell → quote request carries Base WETH `0x4200…0006`; mainnet → `0xC02a…` unchanged
  (byte-identical, test-pinned).
- ERC20→ERC20 on both chains unchanged. Order build uses the same mapping as the quote.
- A regression test pinning getWrappedNative per chainId (throws/falls back safely on unknown chain).

## Do NOT
- No changes to the 9T partnerFee/appData work, fail-soft, gates, FeeCollector, or other adapters'
  logic beyond the WETH-mapping sweep. No contract edits. Keys server-only.
- Branch `feat/sprint-9w-cow-wrapped-native`, atomic SSH-signed commits, CI green, append FEEDBACK.
  Not a security gate → no Auditor; Preview-test before prod. Live Force-MEV swap on Base is an OWNER
  post-merge step — do everything automatable and STOP (no loop).
