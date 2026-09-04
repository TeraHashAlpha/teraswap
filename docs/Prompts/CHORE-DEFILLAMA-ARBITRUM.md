# CHORE-DEFILLAMA-ARBITRUM — mirror the merged DefiLlama adapter, add Arbitrum One, stop overclaiming Volume

> **Source:** measured 2026-09-03 against the LIVE upstream adapter. Docs + an off-chain reporting
> integration only — **no Auditor** (no fund flow, no gate, no contract, no keeper). SSH-signed,
> noreply committer. Branch `chore/defillama-arbitrum-methodology` off latest `origin/main` in a
> dedicated worktree. Push and stop — **the owner opens the PR**, and the owner (not the agent)
> opens the follow-up PR against `DefiLlama/dimension-adapters`.
>
> **Written after the fact.** The implementing session was dispatched from a `/goal` paste with no
> spec file on disk; this records what was actually specified and actually done, per
> `_PROMPT-TEMPLATE.md` §6 ("commit the spec in its implementation PR").

## Why — the two defects

Our adapter **merged upstream 2026-07-09** as `aggregators/teraswap/index.ts` (TypeScript
`SimpleAdapter`, `version: 2`, `pullHourly: true`). It is live, and wrong twice.

1. **It configures only `CHAIN.ETHEREUM` and `CHAIN.BASE`.** Arbitrum One's FeeCollector has been
   emitting `SwapWithFee` since 2026-07-17, after that merge. An unconfigured chain does not error
   — it reports zero. Scale is small and must be stated as such: **five** `SwapWithFee` events on
   42161 in total (2026-07-17, ×2 on 2026-07-20, ×2 on 2026-08-03, none since). This is a
   configuration error being corrected, not a material restatement of volume.
2. **`methodology.Volume` overclaims.** It calls the FeeCollector "the single contract every
   TeraSwap swap routes fee-collection through". `FEE_INCOMPATIBLE_SOURCES` in
   `src/lib/constants.ts` says otherwise: those sources take the identical 0.1% through their own
   partner-fee parameters, emit no `SwapWithFee`, and are invisible to this adapter. At least one
   is live and quoting today.

Note the repo could not see either defect, because what it kept was a pre-submission draft
(`integrations/defillama/teraswap.js`) still targeting `dexs/teraswap/index.js` — a path DefiLlama
never used for this adapter.

## Requirements

**Commit 1 — mirror, add the chain, un-overclaim the methodology.**

1. Add `integrations/defillama/teraswap-adapter.ts`, an in-repo mirror of the MERGED upstream
   shape: `SimpleAdapter` `version: 2`, `pullHourly: true`, `chainConfig` of
   `{ feeCollector, start }` with `start` as **date strings**, `methodology` +
   `breakdownMethodology`, `dailyRevenue` and `dailyProtocolRevenue`, `METRIC.SWAP_FEES`.
   The filename must NOT collide with the `.js` draft's basename (see Quality criteria).
2. Mark `teraswap.js` `@deprecated superseded by teraswap-adapter.ts`. **Do not delete it**
   (CLAUDE.md rule #4). Rewrite `PR-NOTE.md` for the real upstream path and paste procedure.
3. **Addresses are derived, never hand-typed.** Take every FeeCollector address from the
   `docs/DEPLOYMENTS.md` table **qualified by chain** (that doc records two collisions where one
   address is a different contract per chain — 1, 8453, 42161). Extract them programmatically,
   print a **length sentinel (42)** per chain, and put a source comment naming the doc row and the
   chain above each. Exclude the frozen V1 row ("do not route here") and the Sepolia row.
4. Verify each address with `eth_getCode` **on its own chain**, after checking that RPC's
   `eth_chainId`. Non-empty required; report the byte count. No code ⇒ not added.
5. **Derive the Arbitrum `start`** from the FIRST `SwapWithFee` log at that address on 42161 —
   state the block and the method. If RPC range limits block the query, fall back to the doc's
   prod-flip date and **say so explicitly**.
6. Rewrite `methodology.Volume`: drop "every TeraSwap swap", say the excluded sources collect the
   identical 0.1% via their own partner-fee mechanism, emit no `SwapWithFee`, are therefore NOT
   counted, and **name them**. Read the names from `FEE_INCOMPATIBLE_SOURCES`; do not copy them
   from any prompt. Keep `Fees` / `Revenue` / `ProtocolRevenue` wording byte-identical to upstream.

**Commit 2 — reconcile the record (amendment, added on top; no amend, no force-push).**

7. `docs/DEPLOYMENTS.md` dates the Arbitrum prod flip 2026-07-20 and the chain disagrees by three
   days. Append **one line** to that row with the first on-chain `SwapWithFee` (block, tx, date).
   Change nothing else in that file.
8. The adapter must not contradict its own derivation: no header sentence asserting a production
   date the derived `start` disagrees with, and no comment implying more than five events.
9. Commit this spec.

## Do NOT

- No change to `FEE_BPS`, `FEE_RECIPIENT`, adapters (`src/lib/adapters/**`), contracts, keeper, or
  order engine.
- **No new dependency.** No deletions — supersede, never remove.
- **No project-wide compiler levers to solve a local problem.** `tsconfig.json` must end
  byte-identical to `origin/main`; if a basename collision breaks module resolution, rename the
  file, do not relax `allowImportingTsExtensions` (or reorder `resolve.extensions`) for the repo.
- No PR, no Auditor, no CI polling. Do not run `ssh-add`, read `.env*`, or touch a server.
  Public-RPC **reads** are allowed and expected.

## Files affected (read ONLY these)

- `integrations/defillama/teraswap-adapter.ts` (new) · `integrations/defillama/teraswap.js` ·
  `integrations/defillama/PR-NOTE.md`
- `__tests__/defillama-teraswap-adapter.test.ts` (new)
- `docs/DEPLOYMENTS.md` (one row) · `docs/Prompts/CHORE-DEFILLAMA-ARBITRUM.md` (this file)
- read-only: `src/lib/constants.ts`, `src/lib/on-chain-monitor.ts`, `vitest.config.ts`

## Expected output

Branch `chore/defillama-arbitrum-methodology`, SSH-signed commits, pushed; compare link reported;
local verification done (the agent never opens the PR, never polls CI). FEEDBACK carries: the
addresses with sentinels and `eth_getCode` sizes, the derived Arbitrum `start` with its evidence,
the topic0 controls, the final methodology sentence verbatim, and the acceptance results.

## Quality criteria (the acceptance bar)

1. **Exactly three chains.** Each configured address equals the `docs/DEPLOYMENTS.md` row for
   **its** chain by **computed lower-cased equality** (the doc re-parsed inside the test, not a
   value copied into it), plus a negative control proving mainnet ≠ Base. The Base/Arbitrum
   collision is asserted as deliberate, not incidental.
2. **`eth_getCode` byte count reported per chain, all non-empty** — 5,419 / 5,339 / 5,339 as
   measured 2026-09-03.
3. **topic0 re-derived by keccak in the run and matching** the 7-arg
   `SwapWithFee(address,address,address,uint256,uint256,address,uint256)`; the **5-arg form shown
   NOT to match** (control against a truncated ABI).
4. **The excluded-source list equals `FEE_INCOMPATIBLE_SOURCES` — asserted, not eyeballed.** The
   methodology prose is rendered from that list so it cannot drift out of sync.
5. **Suite green; lint/typecheck at or below today's ceiling** (`--max-warnings 94`, typecheck
   clean). A flake in an untouched file must be identified as such against a clean-`main` baseline,
   not waved through.
6. The guards are **mutation-checked**: a wrong Arbitrum address or a shortened excluded list must
   fail the suite.
