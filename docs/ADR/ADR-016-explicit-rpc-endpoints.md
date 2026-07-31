# ADR-016 — No implicit RPC endpoints

- **Status:** Accepted — 2026-07-27
- **Context incident:** production requests to eth.merkle.io, an endpoint nobody at TeraSwap chose
- **Implemented by:** PR #356 (fix/rpc-transport-hygiene, commit 58f5020)

## Context

On 2026-07-27 the TeraSwap production frontend was making requests to `https://eth.merkle.io` — a third-party RPC endpoint that no one at TeraSwap had selected, evaluated, rate-limit-tested, or written down anywhere in our source. The requests were failing with CORS errors and HTTP 429s, visible to any user with DevTools open.

The endpoint entered our runtime through two mechanisms in `src/lib/wagmiConfig.ts`, neither of which was visible as a URL in our code.

1. A URL-less `http()` call. viem's `http()` invoked with no argument silently substitutes the chain definition's own default endpoint. For mainnet that is `rpcUrls.default.http[0]`, which viem sets to `https://eth.merkle.io` in `node_modules/viem/chains/definitions/mainnet.ts:8-11`. The host arrived as a dependency default. Reading our own configuration file top to bottom would never have revealed it.

2. `fallback(transports, { rank: true })`. The `rank: true` option starts `rankTransports_()` (`node_modules/viem/clients/transports/fallback.ts:193-205, 225-317`), which self-reschedules indefinitely and pings every transport in the list with `net_listening` at the client polling interval, for the entire lifetime of the client. There is no exit condition. This is a background loop, not a bounded retry — and it is what turned a single bad endpoint into a request storm.

Measured impact: approximately 192 requests per page load on mainnet, of which roughly 24 went to merkle. A control test — the same browser, the same wallet extension, loading app.uniswap.org — produced 0 merkle requests, which is what established that the origin was our code and not the user's environment. (Wallet extensions wrap `window.fetch`, so DevTools attributed all our requests to `injected.js`; the Initiator column was actively misleading, and two earlier hypotheses were wrong because of it. Comparing the same browser against a third-party dapp is the fastest way to separate "our problem" from "environment noise".)

## Blast radius, and why it was not worse

Fund flow was never exposed. `useSwap`, `useSplitSwap`, and `swap-simulation` route through a separate client factory — `src/lib/chains/clients.ts` and `src/lib/rpc.ts` — which never reads wagmi config and never touched merkle. That deliberate isolation confined the leak to the UI layer.

That isolation was good prior design, but it was not a stated control. Nothing prevented a future contributor from wiring a fund-flow read through the wagmi transport. This ADR converts a fortunate architectural property into an explicit rule.

What was exposed: the Chainlink read paths — `useChainlinkPrice` and `useDepegCheck` — run through the wagmi transport. `useDepegCheck` is documented as fail-open on stale or failed reads. An unreliable third-party endpoint we never chose was therefore in a position to influence whether a depeg check silently passed. That defect is tracked separately (`fix/oracle-fail-closed`); it is named here because it is the reason this ADR is a security decision and not a performance one.

## Decision

**No RPC endpoint may enter TeraSwap's runtime implicitly.**

- Every RPC URL must be written down by us. Every endpoint used by any client, on any chain, in any environment, must appear in our source as a literal string or as an explicitly-named environment variable. If you cannot point at the line that names the host, the configuration is invalid.
- `http()` must never be called without a URL argument. A bare `http()` is a defect on sight, regardless of the surrounding logic.
- Dependency chain definitions are not a source of endpoints. Chain objects imported from viem (or any dependency) are used for chain id, native currency, and contract addresses. Their `rpcUrls` field is not to be relied upon, directly or by omission.
- `rank: true` is prohibited in browser-mounted clients. Ranking buys marginal latency selection at the cost of an unbounded background request loop that exercises every endpoint continuously rather than on demand. Where a `fallback()` is genuinely needed, it is used without ranking.
- "No environment variable" must never mean "let the library decide." Where an env var is absent, the code supplies an explicit, named default — e.g. `http('https://eth.llamarpc.com')` — following the convention already established in `src/lib/rpc.ts` and `src/lib/on-chain-monitor.ts`.
- Browser clients route through our own proxy. Client-side traffic goes to `/api/rpc` rather than to a public endpoint directly, so that rate limiting, origin control, and API-key custody remain under our control.

## Consequences

- Adding a chain now requires an endpoint decision. Whoever adds a chain must choose a provider and put the URL in the diff, where a reviewer sees it. This is a small recurring cost, paid deliberately, in exchange for never again discovering a host in production that no one chose.
- Dependency upgrades can no longer silently redirect user traffic. Before this decision, a viem release editing a chain definition would have re-pointed our users' browsers at a different third party with no diff on our side and no signal in review. That class of supply-chain drift is now closed for RPC.
- Measured result. Requests per page load on mainnet fell from ~192 to ~30 after PR #356, and merkle requests to 0, confirmed in production. Removing `rank: true` accounts for most of the volume reduction; removing the implicit transport accounts for the merkle share.
- Endpoints become an auditable inventory. "Which third parties do our users' browsers contact?" is now answerable by reading our source. That is a precondition for any privacy or supply-chain claim we make publicly, and it aligns the RPC layer with the posture we already state for contracts: the frontend is a suggestion, the protocol is the law — but the frontend should at least be honest about who it talks to.
- Accepted cost. Explicit defaults mean we carry named third-party hosts in source (currently `eth.llamarpc.com` for the server-side no-env case). This is deliberate: a host we chose, reviewed, and can grep for is strictly better than one a library chose for us. These entries should be revisited whenever provider reliability changes.

## Enforcement

Reviewers reject any diff that introduces a URL-less `http()`, sets `rank: true`, or depends on a dependency's `rpcUrls`.

A static CI guard should be added to the existing guard family (`api-hardening-guard`, `catalog-address-guard`, `client-ip-trust-guard`) asserting rules 2, 3, and 4 mechanically. Until that guard exists, this ADR is enforced at review — and a rule enforced only by attention is a rule with a decay rate, so the guard is the intended end state, not an optional extra.

## Related

- [ADR-015](ADR-015-order-execution-economics.md) (order execution economics) — establishes that per-chain gas economics, not token properties, should drive per-chain configuration. The same reasoning applies to endpoint selection.
- `fix/oracle-fail-closed` — the fail-open depeg check that this incident exposed. A guard that cannot verify must block, not pass.
