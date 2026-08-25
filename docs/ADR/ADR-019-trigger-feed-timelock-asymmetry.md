# ADR-019 — Trigger-feed timelock asymmetry

- **Status:** Accepted — 2026-08-07
- **Context:** review of P6's scope (ADR-013 §1) against the admin surface of
  `TeraSwapOrderExecutorV3.sol`, measured at `246cd7b`
- **Judges:** the deliberate scope choice closed by P6, not a new change

## Context

`TeraSwapOrderExecutorV3.sol` carries two oracle-registration paths with different admin gates:

- `setOracleConfig` (`:923`) registers a Chainlink **trigger** feed with per-feed bounds
  (`maxStaleness`, `minPrice`, `maxPrice`) — admin-only, **instant**.
- `queueTokenUsdFeed` / `executeTokenUsdFeed` (`:962` / `:986`) register the **fair-value**
  token→USD feed used for swap pricing — behind `TIMELOCK_ORACLE_CHANGE` (48h) +
  `TIMELOCK_GRACE` (7d).

This is not an inconsistency to fix. The docblock above `setOracleConfig` (`:921-922`) states the
scope on purpose: *"this trigger-feed registration keeps the v2 behaviour for the price-condition
check only."* P6 (ADR-013 §1) closed the fair-value oracle under a timelock and deliberately left
the trigger-feed path as it was in v2. This ADR records why that scope is accepted, so a future
reader does not mistake it for an oversight.

## Blast radius, measured

`oracleConfigs` is read at exactly one site: `_checkPriceCondition` (`:1121`, inside the function
starting at `:1100`), reached from two call sites (`:393`, `:504`). Its effect is bounded three
ways:

1. **The admin cannot redirect an existing order to a different feed.** `order.priceFeed` is part
   of the signed EIP-712 struct (`ORDER_TYPEHASH`, `:120-123` — `priceFeed` is one of the signed
   fields). The user signed the feed address; an instant `setOracleConfig` call can only change
   that feed's `maxStaleness` / `minPrice` / `maxPrice`, never which feed an order reads.
2. **DCA never consults it.** `_checkPriceCondition` treats a zero `priceFeed` as "execute
   unconditionally on schedule" (`:1105-1106`). Only Limit / Stop-Loss / Take-Profit orders read
   `oracleConfigs` at all.
3. **The outcome is still bounded by the signed order.** Even a maximally widened `maxStaleness`
   only changes *when* a trigger condition is judged satisfied — the resulting swap still enforces
   the signed `minAmountOut`, the router whitelist, and `recipient == owner`.

## Decision

**Accept the asymmetry (Option A): leave `setOracleConfig` instant.**

Tightening `minPrice` / `maxPrice` on a trigger feed can stall a conditional order immediately, but
`pause()` (`:903`) is already admin-only and instant, and freezes *all* order execution — Limit,
SL, TP, and DCA alike. An instant `setOracleConfig` grants no censorship capability that `pause`
does not already grant more broadly. The only capability `setOracleConfig` adds on top of `pause`
is narrower and different in kind: widening `maxStaleness` so a stale Chainlink round satisfies a
trigger early, mistiming when a Limit/SL/TP fires. This is not nothing — for a stop-loss, the
decision to sell can be stolen in time, and a mistimed fill can be worse than no fill. It is
accepted because the outcome stays bound by the signed `minAmountOut`, the router whitelist, and
`recipient == owner`: **wrong timing, never wrong funds**, and the timing risk is already dominated
by the strictly larger, already-accepted `pause` capability — not because the marginal risk is
harmless on its own.

## Revisit trigger

This decision is conditioned on `pause()` remaining instant and admin-gated exactly as it is today.
If a future version removes `pause` or puts it behind a timelock, the dominance argument this ADR
relies on no longer holds and the scope must be re-derived — `setOracleConfig` would then need its
own justification, independent of `pause`. Any resulting change requires a new `OrderExecutor`
version and a migration; this contract cannot be modified in place.

## Related

- [ADR-013](ADR-013-order-onchain-floor.md) §1 — the P6 decision that timelocked the fair-value
  token→USD oracle; this ADR judges the trigger-feed scope that decision deliberately excluded.
