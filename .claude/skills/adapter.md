# Skill: Creating / Modifying DEX Source Adapters

Apply this skill whenever the task adds or edits a liquidity-source adapter
under `src/lib/sources/`.

## File location

- Pattern: `src/lib/sources/{source-id}.ts` (lowercase, e.g. `paraswap.ts`, `odos.ts`, `oneinch.ts`).
- File name == source id == entry in the `SOURCES` constant and `SourceId` union.
- Adapter tests: `src/lib/sources/{source-id}.test.ts` for unit + a forked-mainnet integration where applicable.

## Interface

- Implement `QuoteAdapter` from `@/lib/types`.
- Required: `getQuote(req): Promise<Quote>` and `buildSwapTx(req): Promise<SwapTx>`.
- Optional: `getSplitQuote()` when the source supports multi-hop splitting.
- Export the adapter as a single object literal — keep it plain so the registry can introspect it.

## Errors

- Throw `SourceError` from `@/lib/source-error`. Never throw bare `Error`.
- Always set `sourceId` and a stable `reason` enum value so the state machine can react.
- Network timeouts / 5xx → `SourceError('NETWORK_FAILURE')`; never swallow.

## Price validation

- Chainlink oracle check is mandatory for any non-zero amount (see `validateChainlink()`).
- DefiLlama is the secondary check; when DefiLlama is unavailable, **block** swaps > $10k (do not fail-open).
- Single-source price data is never trusted — quorum logic lives in `src/lib/quorum-check.ts`.

## Router & calldata safety

- Only call addresses in `ROUTER_WHITELIST` (`src/lib/swap-security.ts`). Reject any other `to`.
- Run `validateCalldata(tx)` from `@/lib/swap-security` before returning a SwapTx.
- Verify the recipient encoded in calldata matches the user via `calldata-recipient` decoder — never trust the source's response blindly.

## Disabled sources

- Do **not** re-enable a source flagged in `Audits/Incidents/INC-*` without satisfying the reactivation criteria in that incident (e.g. §4.3 of INC-2026-04-14-001 for CoW).

## Naming & registration

- Source id is lowercase kebab/single-word matching `AggregatorName` union.
- Register in `src/lib/sources/index.ts` (or the equivalent registry) — do not auto-discover.

## Testing

- Unit test: mock HTTP responses; cover quote, swap-tx build, Chainlink mismatch, router-whitelist rejection, calldata validation failure.
- Integration: forked-mainnet test (Foundry or Anvil-backed vitest) for at least the golden path.
- Always assert that `SourceError` is thrown with the correct `reason` on failure modes.
