## Feedback — fix/arbitrum-feed-verification

### Deviation from the stated file list

The prompt listed `src/lib/chains/chainlink-feeds.ts` (comment only), read-only `registry.ts`, and a
new `docs/Prompts/VERIFY-ARBITRUM-CHAINLINK-FEEDS.md`. I also added
**`scripts/verify-arbitrum-chainlink-feeds.mjs`**.

Rationale, since it is scope beyond the list: the finding being closed is *"these were verified once,
under a premise that later became false, and nobody re-checked."* A doc records that a check was run;
a script makes it **re-runnable** by anyone, at any time, without trusting the doc. The repo already
establishes exactly this pattern (`scripts/verify-arbitrum-addresses.mjs`,
`scripts/verify-base-cbeth-feeds.mjs`, `scripts/verify-deployed-sources.mjs`), and the new script
improves on the first of those in one respect that matters here: it **parses the addresses out of
`chainlink-feeds.ts`** instead of carrying its own copies, so it cannot drift from the config it
verifies. It changes no addresses, thresholds, or logic and is not wired into CI. Drop it if
unwanted — the doc stands alone.

### Security concern — the browser Chainlink hook has no L2 sequencer gate

Surfaced by Task 4, **not implemented** (the prompt reserves that decision).

`src/lib/chainlink.ts:532-541` (`fetchChainlinkPriceRaw`) gates every L2 price read on
`isSequencerUp`, and `TeraSwapOrderExecutorV3._sequencerUp()` enforces the same on-chain at
settlement. But `src/hooks/useChainlinkPrice.ts` has **no sequencer reference at all** — it resolves
feeds with `resolveFeed` and reads them directly client-side via wagmi `useReadContract`, never
passing through `fetchChainlinkPriceRaw`.

During a sequencer outage or its 1 h post-recovery grace window, the browser would therefore display,
and derive from, a frozen answer — including the DCA signing-floor preview, which consumes
`useChainlinkPrice`'s `chainlinkPrice` for both legs — while the quote/swap path and the executor
both correctly refuse. `getFeedStalenessSec` (heartbeat × 1.5) is a *partial* mitigation only: a feed
frozen for less than its ceiling still reads fresh, and the grace window is not a staleness condition
at all.

The coverage it *does* give is incidental and very uneven across the five feeds: an outage trips
`ETH / USD` after 2633 s (~44 min), but `DAI / USD` and `WBTC / USD` — 86 400 s heartbeat, 129 600 s
ceiling — not until **36 hours**. A multi-hour sequencer outage would leave those two reading
"fresh" in the browser for its entire duration. And no staleness ceiling covers the post-recovery
grace window at any heartbeat, because a lagging round published after recovery is genuinely fresh.

### Assumption that turned out wrong

The verification script's first run failed to parse the config. `CHAINLINK_FEEDS_BY_CHAIN` is typed
``Record<number, Record<string, `0x${string}`>>``, and the `{` inside that **template-literal type**
was picked up as the object literal's opening brace, yielding an empty body and a
`parse: opener not found: 42161:` error. Worth knowing for any future tool that reads this file as
text: brace-matching over TS source must skip `{` preceded by `$`. The script does, and asserts it
parsed exactly 5 feeds so a future parser drift fails loudly rather than verifying nothing.

### Observation — freshness margins (reported, not acted on)

At sample time `USDC / USD` was at **80 % of its 255 s heartbeat** (205 s). The ×1.5 ceiling leaves a
~2-minute window past a missed round before the feed reads stale. Single sample, not a trend — but
the short-heartbeat feeds (USDC/USDT, 255 s) are structurally the ones where a normal late round sits
closest to the staleness cliff. `DAI / USD` at 11 h 13 m is expected for an 86 400 s
deviation-threshold feed with a quiet peg, and is comfortably inside its ceiling.
