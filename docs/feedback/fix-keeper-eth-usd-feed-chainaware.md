# Feedback — FIX-KEEPER-ETH-USD-FEED-CHAINAWARE

## What shipped

`eth-usd-feed.js` (new pure module) resolves `env → chain default → null`. `executor.js` uses it,
`readEthUsd` short-circuits on a null feed before any read, and the resolved address + its
provenance is logged once at boot. Mirror: `1` ← `constants.ts` `CHAINLINK_ETH_USD`, `8453` /
`42161` ← `chainlink-feeds.ts` `CHAINLINK_FEEDS_BY_CHAIN[…]` WETH → ETH/USD.

**Byte-identical where it matters:** mainnet resolves the same literal as before with the env
unset *or* set; Base/Arbitrum with the env set pass it through verbatim (no normalising, no new
validation — an odd operator value still fails exactly where it failed before, at `getAddress`).
Suite: **309 pass / 0 fail** (289 on `main`).

## Assumption that turned out wrong

- The prompt reads as if `chainlink-feeds.ts` alone is the source of truth, but its mainnet entry
  is `CHAINLINK_FEEDS` **imported from `src/lib/constants.ts`**, and `getChainlinkFeed(WETH, 1)`
  returns `CHAINLINK_ETH_USD` from there. Pinning chain 1 therefore required following that one
  import into `constants.ts` — a single `export const` line, read-only. It confirms the keeper's
  old hardcoded `0x5f4e…8419` *was* the correct mainnet address, so nothing about mainnet changes.

## Edge case

- **`readEthUsd` would have called `getAddress(null)`** once the fallback tail was removed. That
  throws, gets swallowed by the existing `catch`, and returns null — the right *outcome* by
  accident, but via an exception every cycle and with a misleading "feed read failed" log. Added an
  explicit guard that returns before any read, with a one-time warning (the condition is static for
  the process; `readEthUsd` runs per cycle *and* per ETH leg, so an unguarded log would drown the
  one line that matters).

## Test gap closed, and one left open

- The drift guard is **negative-tested**: corrupting one character of the Base address makes
  `eth-usd-feed.test.mjs` fail, so the mirror cannot rot silently. It parses the TS structurally
  (chain block → the entry under the `ETH/USD` comment) so no address is typed in the test either.
- **Still open:** the guard is brittle to *reformatting* of `chainlink-feeds.ts` — a moved comment
  breaks the parse. It fails loudly rather than silently, which is the right direction, but the
  durable fix is a generated JSON artifact shared by both packages. Same underlying gap flagged in
  #345 (`executor.js` constants asserted via source text because the file calls `main()` on
  import). Worth one chore covering both.

## Concern

- **Three `arbitrum-plumbing.test.mjs` assertions from #345 had to be repointed** — they matched
  the `ETH_USD_FEED_BY_CHAIN` const that this fix removes from `executor.js`. They now assert the
  resolved *value* via `resolveEthUsdFeed` instead of an `executor.js` source regex, which is
  strictly stronger; the 42161-vs-manifest pin is preserved. Flagging it because a reviewer
  diffing #345 against this branch will see those three tests change shape.
- **Ops follow-up (not code):** this makes an unset `ETH_USD_FEED` *correct* on Base rather than
  merely survivable, but the live keeper's `.env.executor` still sets it. Worth confirming that
  value equals `0x71041ddd…16Bb70` — if an operator ever set a stale or wrong address there, the
  env override silently beats the now-correct default, and this fix would not save it.
