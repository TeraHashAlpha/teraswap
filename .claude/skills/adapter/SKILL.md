---
name: adapter
description: Use when creating or modifying a DEX liquidity-source adapter under src/lib/adapters/.
---

# Skill: Creating / Modifying DEX Source Adapters

Apply this skill whenever the task adds or edits a liquidity-source adapter
under `src/lib/adapters/`.

## File location

- Pattern: `src/lib/adapters/{name}.ts` (lowercase, e.g. `velora.ts`, `kyberswap.ts`, `oneinch.ts`).
- The adapter's `name` is a member of the `AggregatorName` union (`src/lib/constants.ts`). It is usually the file name;
  the exceptions are `oneinch.ts` → `1inch`, `zerox.ts` → `0x` and `cow.ts` → `cowswap`.
- Adapter tests sit beside the adapter: `src/lib/adapters/{name}.test.ts`.

## Interface

- Implement `DEXAdapter` from `src/lib/adapters/types.ts`: `name`, `fetchQuote(params)` and `fetchSwapData(params)`,
  both resolving to `NormalizedQuote | null`.
- Export the adapter as the module's default export, a plain object.

## Errors

- A source failure is classified and logged by the circuit breaker (`src/lib/adapters/circuit-breaker.ts`): source,
  error class and HTTP status, never a response body, URL or query string (`dead-sources-are-loud.test.ts`). Keep
  provider URLs and keys out of error messages.
- Network timeouts / 5xx surface as failures; never swallow them.

## Price validation

- Chainlink validation is mandatory for all swaps (`src/lib/chainlink.ts`, feeds per chain in `src/lib/chains/chainlink-feeds.ts`).
- DefiLlama is the secondary check; when DefiLlama is unavailable, **block** swaps > $10k (do not fail-open).
- Single-source price data is never trusted — quorum logic lives in `src/lib/quorum-check.ts`.

## Router & calldata safety

- Routers are allow-listed per chain: `ROUTER_WHITELIST_BY_CHAIN` (`src/lib/chains/routers.ts`). A router valid on one
  chain proves nothing on another.
- Call only a router on the list of the quote's chain and reject any other `to` (`isWhitelistedRouter(to, chainId)`, same
  file; the swap paths check it with `validateRouterAddress`, which on mainnet reads `ROUTER_WHITELIST` in
  `src/lib/api.ts`).
- Validate swap calldata before it is used: the selector with `isKnownSwapSelector` (`src/lib/swap-selectors.ts`), and
  the recipient (next line).
- Verify the recipient encoded in calldata matches the user via `src/lib/calldata-recipient.ts` — never trust the
  source's response blindly.

## Disabled sources

- A source listed in `DISABLED_SOURCES` (`src/lib/constants.ts`) is re-enabled only once its entry's written re-enable
  criterion is met.
- Do not re-enable a source flagged in an incident report under `Audits/Incidents/` without meeting that report's
  reactivation criteria (e.g. §4.3 of INC-2026-04-14-001, `Audits/Incidents/2026-04-14-cowswap-dns-hijack.md`, for CoW,
  which was re-enabled on 2026-04-23 and is not in `DISABLED_SOURCES`).

## Naming & registration

- Register the adapter in `ADAPTER_REGISTRY` (`src/lib/adapters/index.ts`) — there is no auto-discovery.

## Testing

- Unit test: mock HTTP responses; cover quote, swap build, Chainlink mismatch, router-whitelist rejection on the
  adapter's chains, recipient mismatch, and the failure paths.
- Integration: forked-mainnet test (Foundry or Anvil-backed vitest) for at least the golden path.
