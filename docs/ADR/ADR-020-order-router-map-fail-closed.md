# ADR-020 — The order-engine router map fails closed

- **Status:** Accepted — 2026-09-02
- **Context finding:** `Audits/Sprint/ARBITRUM-V3-STATE-2026-08-26.md` §4 **B6** — the order-engine
  router map has no 42161 entry, and answered for it anyway
- **Implemented by:** `fix/order-router-map-fail-closed`

## Context

TeraSwap carries three different sets of "routers for chain N", written by different people for
different reasons, and until this decision nothing said which was authoritative for what — or what
any of them should do when handed a chain it had never heard of.

**State at decision time** (measured on `origin/main` @ `e1b024d`, 2026-09-02):

| Set | Where | Chain 1 | Chain 8453 | Chain 42161 | What it gates |
|---|---|---|---|---|---|
| Order-engine router map | `src/lib/order-engine/config.ts` `ROUTERS_BY_CHAIN` | **4** (`MAINNET_ROUTERS`) | **2** (`BASE_ROUTERS`) | **absent** | the `router` address committed into a SIGNED conditional order |
| Swap-path whitelist | `src/lib/chains/routers.ts` `ROUTER_WHITELIST_BY_CHAIN` | **12** | **12** | **12** | which `tx.to` / approval spender an instant swap may use |
| The chain's own executor | deployed `TeraSwapOrderExecutorV3` on Arbitrum One | — | — | **11** whitelisted routers (Bootstrap events, inventory §2.2/§3.1) | what the contract will actually accept at `executeOrder` |

(The swap gate's *effective* mainnet set is larger than the 12 primaries: `getRouterWhitelist(1)`
short-circuits to `MAINNET_FULL`, 16 literal entries plus the optional FeeCollector, plus Bebop's
spenders. The 12/12/12 above are the per-source primary maps, which is the row that compares
like-for-like with the other two sets.)

`getWhitelistedRouters(chainId)` resolved `ROUTERS_BY_CHAIN[chainId] ?? MAINNET_ROUTERS`, and
`getDefaultRouter(chainId)` added a second fallback on top of it —
`routers[DEFAULT_ROUTER_KEY_BY_CHAIN[chainId] ?? '1inch'] ?? MAINNET_ROUTERS['1inch']`. A chain the
file had never heard of therefore received **mainnet's answer, stated with mainnet's confidence**.

On Arbitrum One that produced the exact failure B6 describes. The default router resolved to
1inch v6 `0x1111…2A65`, which *is* whitelisted on the Arbitrum executor — but only because 1inch
deploys that router at the same address on every chain. A cross-chain address collision is a
coincidence, not a whitelist. The canonical pinned-route router resolved to mainnet's Uniswap V3
SwapRouter `0xE592…1564`, which reads `whitelistedRouters = false` on the deployed Arbitrum
executor (inventory §2.7, both RPCs). An order pinned to it would have signed cleanly and reverted
`RouterNotWhitelisted` on every fill until expiry — unexecutable, cancel-only, with the user's
approval already spent.

The part that makes this a class of defect rather than a typo: **`isWhitelistedRouter` could not
have caught it.** It validated the committed router against `getWhitelistedRouters(chainId)` — the
same fallback — so on Arbitrum it was checking mainnet's map. The signing path, the assertion that
guards the signing path, and the server-side gate that re-checks it all read one wrong answer and
agreed with each other. A guard that derives its expectation from the same silent default it is
meant to guard is not a guard.

None of this had reached production. It was latent only because `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS`
is `[8453]`, so 42161 never resolved a v3 executor and the panels stayed dark
(INC-2026-08-26-001). That is protection by an unrelated allowlist, not by this map. The day 42161
joins that list — which is the explicit goal of the Arbitrum work — B6 becomes live in the same
commit, and nothing in this file would have said so.

## Decision

**A chain map that does not know the chain must fail closed. It must never answer with a sibling
chain's data.**

### (a) An unknown chain gets nothing

For any `chainId` absent from `ROUTERS_BY_CHAIN`:

- `getWhitelistedRouters(chainId)` returns an **empty map** — a frozen, shared `{}`, so no caller
  can mutate the fail-closed answer into a permissive one, and there is exactly one "we don't know
  this chain" object to reason about.
- `getDefaultRouter(chainId)` returns **`null`**, and its return type is `RouterEntry | null`. The
  nullable type is the enforcement: `getDefaultRouter(chainId).address` is now a compile error, so
  a future caller cannot reintroduce the silent substitution without the typechecker objecting.
  There is no fallback default key either — the `?? '1inch'` is gone.
- `getCanonicalRouteRouter(chainId)` returns **`null`** (unchanged code; it was already fail-closed
  *by construction*, but that construction only holds once the map underneath it is).
- `isWhitelistedRouter(chainId, …)` is **`false` for every address**, including addresses that are
  genuinely whitelisted on mainnet.

Every caller must REFUSE on that answer — with a named error the user can read — and never
substitute. The three order-creation panels show one shared reason string,
`NO_ROUTER_FOR_CHAIN_REASON`, so the copy cannot drift apart and a reviewer can grep one symbol to
find every refusal site. `/api/orders` refuses with its existing
`Router … is not served on chain N` 400.

Mainnet (1) and Base (8453) are byte-identical. That is pinned by inline snapshots of both maps and
both default routers, captured by running the test file against the pre-change code.

### (b) The order map is a subset of the chain's on-chain whitelist, and is derived, not typed

A chain appears in `ROUTERS_BY_CHAIN` only when its set has been **derived from that chain's
deployed executor** — read from the executor's own `Bootstrap` / router-change events or
`whitelistedRouters()` probes — and then **intersected with what `/api/swap` can actually serve on
that chain**. Both halves are load-bearing:

- A router the executor does not whitelist produces an order that reverts on every fill
  (`RouterNotWhitelisted`).
- A router `/api/swap` cannot build calldata for strands the order just as completely — the keeper
  has nothing to submit. This is why Base carries 2 entries and not the 3 its executor whitelists:
  1inch v6 is whitelisted on-chain but `/api/swap` returns 502 for it on Base (PR #225's
  `SwapFailed` root cause).

So the map is an **intersection**, and therefore always a subset of the on-chain set. Entries are
never typed from a runbook, from a sibling chain, or from an address that "looks the same
everywhere". Adding a chain's entries is a scripted derivation from the deployed executor plus a
recorded `/api/swap` serveability check, reviewed as a change to fund flow.

### (c) `routers.ts` and `config.ts` are different sets on purpose

They answer different questions and are authoritative for different things:

- **`src/lib/chains/routers.ts` (`ROUTER_WHITELIST_BY_CHAIN`) is authoritative for the instant-swap
  path.** It answers "may this `tx.to` be called, and may the user approve this spender, right
  now?" Its members are validated against a live quote, executed in the same transaction the user
  is looking at, and never persisted. It is deliberately broad — it includes approval spenders and
  settlement contracts that are not swap routers at all (Permit2, CoW's VaultRelayer, Bebop's
  JamSettlement) — because that is the correct answer to *its* question.

- **`src/lib/order-engine/config.ts` (`ROUTERS_BY_CHAIN`) is authoritative for order signing.** It
  answers "which router may be written into an EIP-712 message the user signs today and a keeper
  replays for up to 90 days?" Its members must satisfy a second party the swap path never consults:
  the deployed executor contract, whose whitelist is enforced on-chain at fill time and can only be
  changed through a 48-hour timelock.

The order set is therefore smaller and slower-moving by design, and **the two must not be merged or
made to reference each other.** Widening the order map to match the swap map would sign orders
against routers the executor rejects; narrowing the swap map to match the order map would break
instant swaps for no reason. Where they disagree, neither is wrong — they are answering different
questions. The order map, and only the order map, is bound by (b).

### (d) Adding 42161 to the order map is out of scope

This ADR closes the *silent substitution*. It does not add Arbitrum routers, and deliberately
leaves Arbitrum with an empty set. Populating it is its own audited change and depends on decisions
this ADR does not make — chiefly inventory **B1** (the deployed Arbitrum executor whitelists 11
routers, 9 more than the runbook's stranding rationale was written to justify; those are pruned via
timelock or ratified by audit before any of them belongs in a signing map) and **B5** (no Arbitrum
keeper instance runs). Until then, "empty" is the correct and honest answer, and it is now the
answer the code actually gives.

## Consequences

- **The Arbitrum eligibility flip is no longer silently dangerous.** Adding 42161 to
  `ORDER_EXECUTOR_V3_ELIGIBLE_CHAINS` now surfaces the missing router set as a visible refusal in
  the UI and a 400 from the API, instead of signing mainnet routers into Arbitrum orders. B6 stops
  being a landmine and becomes a checklist item.
- **`isWhitelistedRouter` is a real guard again.** It reads the chain's own set, so it can now
  disagree with the signing path instead of inheriting its mistake.
- **The compiler carries part of the rule.** `getDefaultRouter` returning `RouterEntry | null` means
  the next caller either handles the refusal or fails to build. That is stronger than the comment
  this file used to rely on, and it is why the fix is a type change and not only a value change.
- **Adding a chain costs more than a paste.** Whoever adds one must derive the set from the deployed
  executor and record the `/api/swap` check. That is the intended price: the previous cost was zero
  and the previous default was wrong.
- **Accepted cost: a chain can be "supported" for swaps and refuse conditional orders.** A user on a
  chain TeraSwap swaps on but has no order set for sees "no whitelisted router is configured for
  this network" rather than a working panel. That asymmetry is real, it is visible, and it is
  correct — it reflects exactly what is deployed.
- **Not covered here.** The DCA branch of `/api/orders` never reaches the router gate at all (it is
  scoped to `isV3Order && orderType !== DCA`), so the server-side refusal for DCA rests on the
  client. That gap predates this ADR and is unchanged by it; it is named here so it is not mistaken
  for something this decision closed.

## Enforcement

Enforced at three levels, in decreasing order of strength:

1. **The typechecker.** `getDefaultRouter(chainId).address` does not compile.
2. **Tests.** `src/lib/order-engine/router-map-fail-closed.test.ts` asserts the empty/null/false
   surface for every unknown chain — with the negative-control addresses **read from** the mainnet
   and Base maps rather than typed, so the control fails on the pre-fix code — plus inline snapshots
   of chains 1 and 8453 captured before the change. Each consuming path has its own refusal test
   (the three creation panels, `/api/orders`, the settlement receipt's route label).
3. **Review.** Any diff adding a key to `ROUTERS_BY_CHAIN` must cite the on-chain derivation for
   that chain's executor and the `/api/swap` serveability check, per (b). A reviewer rejects a
   router address that arrives by any other route.

## Related

- [ADR-013](ADR-013-order-onchain-floor.md) — the on-chain floor v3 exists to enforce. A pinned
  route that reverts is the floor never being reached at all.
- [ADR-014](ADR-014-nondca-execution-model.md) — pinned canonical routes for non-DCA orders; the
  path `getCanonicalRouteRouter` serves, and the one B6 broke on Arbitrum.
- [ADR-016](ADR-016-explicit-rpc-endpoints.md) — same shape, different layer: a value that enters
  the runtime by dependency default rather than by our decision. "If you cannot point at the line
  that names it, the configuration is invalid" applies to routers as much as to RPC hosts.
- `Audits/Sprint/ARBITRUM-V3-STATE-2026-08-26.md` — the on-chain inventory this decision reads
  (§2.2 events, §2.7 discriminating router probes, §4 B1/B5/B6).
- `Audits/Incidents/INC-2026-08-26-001.md` — the eligibility gate that kept B6 latent, and the reason
  "protected by an unrelated allowlist" is not a control.
