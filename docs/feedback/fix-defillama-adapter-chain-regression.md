## Feedback — fix/defillama-adapter-chain-regression (9c0935f)

### Assumption that turned out wrong

- **The brief (and PR #476's own reasoning) blamed the second `getLogs`. It is innocent.** The
  brief asked why "the second `getLogs` zeroes non-mainnet chains" and, separately, why "the V1
  read returns nothing on mainnet", and said the two might be one cause or two. Measured: they are
  **one cause, and it is neither of those things.** The second `getLogs` never runs on Base or
  Arbitrum (it is behind `if (cfg.legacyFeeCollector)`, mainnet-only) and it works correctly on
  mainnet. The regression is the `start` values that #476 changed in the same commit.

  Proof, same file, same day, one env var apart:

  ```
  pnpm test aggregators teraswap 2026-06-05                       -> base 0.00
  DISABLE_PULL_HOURLY=true pnpm test aggregators teraswap 2026-06-05 -> base 2.70k
  ```

  `DISABLE_PULL_HOURLY` changes nothing about `fetch`; it only collapses the 24 hourly slots into
  one daily window. Same for the V1 read: on the daily path, 2026-03-04 returns `13.00` volume /
  `0.0128` fees from the identical code that returned `0.00` on the hourly path.

  The single mechanism: `setChainValidStart` in `adapters/utils/runAdapter.ts` admits a chain only
  when `start <= endTimestamp - 86400`, and `pullHourly: true` makes the runner split each day into
  24 one-hour slots (`runHourlyMultiSlot`, `cli/testAdapter.ts`), so the earliest slot of day `D`
  ends at `D + 3600`. A `start` equal to `D` clears the test for the 23:00–00:00 slot only. All
  three chains emitted their first log in the morning (mainnet 15:50, Base 07:46, Arbitrum 08:07),
  so all three lost their opening day.

### Deviation from the brief — `start` values were changed, and had to be

- The brief said **"Do not change `chainConfig` addresses or `start` values; they are derived and
  verified."** The `start` values are exactly where the defect lives, and the brief's own
  acceptance criteria (Base back to `2.71k` on 2026-06-05, Arbitrum non-zero, mainnet's V1-only
  window non-zero) are **unreachable without changing them** — the run gate is evaluated before
  `fetch` is ever called, so no change inside the adapter body can reach it. Addresses were not
  touched. Each `start` moved by exactly one day, from its chain's first-log day to the day before,
  and every first-log block/tx/timestamp stays recorded verbatim, so the derivation the brief was
  protecting is intact and still checkable.

  The reading taken: `start` is a **run gate**, not a provenance annotation — upstream types it as
  "indicates when the adapter can start fetching data" (`adapters/types.ts`). Recording the first
  log's day in `start` conflated the two.

### Test gap

- **No in-repo test could have caught this, and none of the 3782 green ones did.** Every guard
  tested the artifact's form — addresses vs. the deployments doc, topic0 hashes, methodology prose,
  generator drift, compilation. Worse, three of them *pinned the bug in place*: they asserted
  `start` was exactly `'2026-03-04'` / `'2026-06-04'` / `'2026-07-17'`, so the broken values were
  protected by name.
- What replaced them: the run-gate arithmetic asserted directly against the first-log timestamps
  (`start <= firstLogDay + 3600 - 86400`), plus a negative control holding the three rejected
  same-day values so the guard cannot quietly stop guarding. Verified by mutation — putting Base
  back to `'2026-06-04'` fails exactly those two tests and nothing else.
- **What that guard still cannot catch:** anything about what the adapter *returns*. It encodes one
  upstream rule as arithmetic; if upstream changes that rule, or breaks something else (`getLogs`
  semantics, `Balances` pricing, a chain key rename), the suite stays green and the numbers are
  still wrong. The stub-`getLogs` test added alongside it is honest about the same limit: it proves
  `fetch` sums a log on every configured chain, which would catch a chain dropped from the fetch
  body, but it **would not have caught this bug at all**, because `fetch` was never called. Hence
  the mandatory harness protocol in `PR-NOTE.md`.

### Concern — pre-existing, upstream, not fixed here

- `cli/buildModules.ts:88` in dimension-adapters **deletes every non-whitelisted key** from
  `adapter.adapter[chain]` (`whitelistedBaseAdapterKeys` = `start`, `deadFrom`, `fetch`,
  `runAtCurrTime`). Because this adapter passes `adapter: chainConfig` — the same object `fetch`
  reads — that build path would strip `feeCollector` and `legacyFeeCollector` from the config
  `fetch` depends on. Not introduced by us and not changed here: the **live merged upstream file
  has the same shape**, and upstream's own `AGENTS.md` §3 explicitly recommends it ("keep it all in
  one `chainConfig` and pass it as `adapter: chainConfig`"). Flagged because it was found while
  reading the runner, it is not exercised by `cli/testAdapter.ts` (the harness path we verified
  against), and if it does bite in production it would zero every chain at once. Worth raising
  upstream rather than working around locally.

### Edge case

- Base legitimately reads `0.00` on 2026-07-18 in **both** baseline and ours — no Base fills that
  day. Only 2026-06-05 is a usable Base regression canary among the four dates; a protocol that
  only checked 2026-07-18 would have called the regression clean.
- The harness prints two different output shapes: a per-chain table when several chains are
  eligible, and a single `ETHEREUM 👇` block when only one is. Grepping for the table format alone
  silently reports "no chain rows" for 2026-03-05 and 2026-05-27 and looks like a total failure.
