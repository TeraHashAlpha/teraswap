# ADR-018 — Feed self-identification

- **Status:** Accepted — 2026-07-29
- **Context incident:** on-chain verification of all 40 configured Chainlink feed addresses found 7
  mainnet entries whose `description()` contradicts their config key
- **Implemented by:** `fix/feed-denomination-guard`

## Context

TeraSwap's Chainlink integration (`CHAINLINK_FEEDS`, `CHAINLINK_FEEDS_BY_CHAIN`,
`COMPOSED_FEEDS_BY_CHAIN` in `src/lib/chains/chainlink-feeds.ts`) is a hand-maintained map from
token address to feed proxy address. Every existing guard — round-integrity validation, per-feed
staleness, the client deviation gate, the `oracleIntegrityFailed` hard block — validates that the
configured address returns a *usable* answer. None of them ever asked the address what it *is*.

An independent on-chain verification pass (2026-07-29, `cast`/JSON-RPC reads of `description()`,
`decimals()`, `latestRoundData()`, `aggregator()` across chains 1/8453/42161) found 7 of the 40
configured mainnet addresses self-identify as something other than what the config key claims:

| config key | on-chain `description()` | on-chain `decimals()` | failure mode |
|---|---|---|---|
| WBTC/USD | `"BTC / USD"` | 8 (matches) | **silent** — passes every existing guard |
| GRT/USD | `"GRT / ETH"` | 18 (config expects 8) | loud (deviation ≈ 10,000×) |
| LDO/USD | `"LDO / ETH"` | 18 | loud |
| SHIB/USD | `"SHIB / ETH"` | 18 | loud |
| APE/USD | — (no on-chain code) | — | loud (read fails) |
| PEPE/USD | — (no on-chain code) | — | loud (read fails) |
| PAXG/USD | — (proxy exists, `aggregator()` is `address(0)`, every read reverts) | — | loud (read fails) |

Six of the seven fail loudly today — a read error, a revert, or a deviation so large it exceeds
`PRICE_IMPACT_CONSENT_CEILING` and hard-blocks via `evaluatePriceGate`'s `extreme-deviation` path.
**WBTC/USD does not.** Its configured address is the canonical BTC/USD index feed. `decimals()`
happens to also be 8, the round is genuinely fresh and valid, and WBTC trades close enough to BTC
parity under normal conditions that the deviation check passes too. The swap-price guard reads a
real, live, correctly-formatted Chainlink answer — for the wrong pair — and cannot tell the
difference, because a WBTC-vs-BTC depeg would move the "expected" price in the same direction as
the real WBTC price, closing exactly the gap the deviation check is watching for.

This is the class of defect the existing architecture cannot catch by construction: **the config
asserts what an address is, and nothing in the read path ever verifies the assertion against the
address itself.**

## Decision

**A price feed must prove its own identity before its answer is used.**

`FEED_EXPECTATIONS` (`src/lib/chains/chainlink-feeds.ts`) declares the exact on-chain
`description()` string and `decimals()` value every configured feed address must return. The read
path — `fetchSingleFeedRaw` (`src/lib/chainlink.ts`, the raw/DCA/order-engine path) and
`useChainlinkPrice` (`src/hooks/useChainlinkPrice.ts`, the swap-UI path) — reads `description()`
and `decimals()` on-chain and compares them against `FEED_EXPECTATIONS` **before** `answer` is
used for anything. Both paths normalise independently today (a pre-existing duplication this
decision does not collapse); each now enforces the check on its own copy of the logic.

### Invariants

**(a) A price feed must self-identify before use.** No `answer` from any Chainlink read reaches a
deviation calculation, a DCA fill, or an order-creation quote without first passing a
description/decimals check against the declared expectation for that address. Enforced at two
levels: an import-time completeness assertion in `chainlink-feeds.ts` (throws if any address the
registry can hand out has no `FEED_EXPECTATIONS` entry — loud in every environment, including every
test run) and a per-read runtime check in both consumers.

**(b) Config is not the source of truth about what an address is.** `FEED_EXPECTATIONS` is a
*claim*, checked against the chain, never substituted for it. The price computed from a passing
read always uses the **on-chain** `decimals()` value (`identity.decimals` in `chainlink.ts`,
`Number(feedDecimals)` — the wagmi read result — in the hook), never the config's
`expectedDecimals`, even when they match. If the chain and the config ever disagree, the chain
wins on what the feed *is*; disagreement itself is the failure signal, not a tiebreak to resolve.

**(c) A description or decimals mismatch is an integrity failure, never a warning.** It is folded
into the exact same `oracleIntegrityFailed` / null-return branch as an invalid, incomplete, or
stale round — the same hard-block semantics `evaluatePriceGate` already gives those failures
(`mode: 'block', reason: 'oracle-integrity'`, no override, no consent-through). A feed that is
readable, fresh, and internally consistent but is *the wrong feed* gets no softer treatment than
one that is unreadable — that gap is precisely what let WBTC/USD pass silently.

**(d) A USD quote may be composed from two declared legs, each independently self-identifying.**
`ResolvedFeed` (`chainlink-feeds.ts`) is a discriminated union — `{ kind: 'single', leg }` or
`{ kind: 'composed', base, quote }` — exhaustive at compile time: `fetchChainlinkPriceRaw`
dispatches on `resolved.kind` with a `default: { const exhaustive: never = resolved }` arm, so a
third shape added later fails the build until every dispatch site is updated. Composed reads
(`fetchSingleFeedRaw` called once per leg) enforce (a)–(c) on *each* leg independently — a
description/decimals mismatch or staleness failure on either leg fails the whole composed read,
with no partial pricing from the leg that happened to pass.

**(e) No fallback path may bypass the check.** `getFeedExpectation` returning `null` (no declared
identity for an address) fails closed — `fetchSingleFeedRaw` returns `null`, the hook falls into
the same `UNREADABLE`-shaped block — rather than reading the feed unchecked. There is no code path
that reads `latestRoundData()` without first passing the identity check for that address.

### Caching

`description()` and `decimals()` are immutable for the lifetime of a Chainlink proxy — Chainlink
rotates the underlying aggregator behind the same proxy address on an upgrade, but the proxy's
self-reported pair and decimal count do not change across that rotation. `chainlink.ts` caches the
**on-chain-read** `{description, decimals}` per `(chainId, address)` for the process lifetime
(`feedIdentityCache`), so the identity check costs one extra pair of RPC calls on first use per
feed per process, not on every 30-second poll or DCA tick. The price itself is never cached — only
identity. A per-address difference (e.g. two different feeds sharing a description by coincidence)
is still caught, because the cache key includes the address, not just the description.

## Accepted regression

**WBTC/USD on Ethereum mainnet stops resolving and starts blocking.** This is the intended effect
of this decision, not a side effect to be mitigated. WBTC/USD is misconfigured today — the address
points at the canonical BTC/USD index feed, which cannot see a WBTC-vs-BTC depeg — and it is
currently *passing*, silently, at every trade size. After this change, `fetchChainlinkPriceRaw`
and `useChainlinkPrice` both return the mismatch as an integrity failure: DCA/order-engine reads
that consult `fetchChainlinkPriceRaw` fall back to the existing no-oracle path (multi-source
compare + on-chain `minimumOutput`), and the swap-UI hard-blocks via `evaluatePriceGate`'s
`oracle-integrity` branch exactly as it already does for a stale or invalid round. Users swapping
WBTC on mainnet will see the same hard-block copy an unreadable feed already produces
("Chainlink feed identity does not match the configured pair") until the address is corrected.
**Address remediation for WBTC/USD (and the other 6 defective mainnet entries) is a separate
goal — this decision does not change any feed address.** Deploying this change without also
scheduling that remediation trades a silent wrong-price risk for a availability regression on one
mainnet pair; that trade is deliberate and is the entire point.

## Consequences

- Every one of the 7 defective mainnet entries now fails closed for the reason that is actually
  true of it (wrong pair / wrong denomination / no code / dead proxy), rather than 6 failing for
  an accidental reason (deviation size, RPC revert) and 1 passing by accident.
- Adding a feed now requires recording its on-chain identity, not just its address — a reviewer
  sees `expectedDescription`/`expectedDecimals` in the diff and can cross-check it against
  `data.chain.link`, closing the "hand-transcribed hex drift" failure mode that produced the
  original Arbitrum defects (`AUDIT-ARBITRUM-46-47`) and this mainnet set.
- The import-time completeness assertion means a future feed added to any of the three registries
  without a matching `FEED_EXPECTATIONS` entry breaks the build/test suite immediately, not in
  production.
- `useChainlinkPrice`'s pre-existing lack of composed-feed support is unchanged by this decision —
  it is a known, separate gap, not newly introduced or newly fixed here.

## Staleness policy for remediated feeds with extended heartbeats

Six of the seven defective mainnet feed addresses identified in this ADR publish at a 86400-second
(24-hour) heartbeat interval, enforced via per-feed heartbeat overrides in `FEED_HEARTBEAT_SEC`
(`src/lib/chains/chainlink-feeds.ts`). Without these overrides, the global staleness threshold
of 3600 seconds would have rendered every price stale immediately after publication, making the
remediation a silent no-op: correct addresses returning correctly-formatted answers that the
existing gates would reject as stale almost always.

At the time of identity verification (2026-07-29), the WBTC/BTC composed leg measured 22.6 hours
old, illustrating the practical consequence: these feeds may legitimately be read at a staleness
boundary of up to 24 hours. In practice, Chainlink also triggers updates on deviation thresholds,
so actual staleness is typically much shorter than the maximum. However, the contractual guarantee
is one day.

**Accepted risk:** TeraSwap users swapping the six remediated mainnet tokens that rely on 24-hour
heartbeat feeds may receive price quotes based on data up to 24 hours old, bounded only by the
deviation threshold of the underlying Chainlink feed.

**Open question (unresolved):** Whether a feed with a 24-hour heartbeat guarantee should face a
tighter deviation threshold to compensate for the longer staleness window, or whether such feeds
should be excluded entirely from any high-value swap waiver. This trade-off between feed availability
and staleness tolerance is not yet decided and should be revisited as part of the mainnet address
remediation work.

## Related

- `AUDIT-ARBITRUM-46-47` / `CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION` — the sibling incident on
  Arbitrum (5 addresses with zero on-chain code, corrected by address). That remediation fixed the
  *addresses*; this decision fixes the *lack of a mechanism* that would have caught a wrong-but-live
  address the same class of error produced on mainnet.
- [ADR-016](ADR-016-explicit-rpc-endpoints.md) — a related "don't trust what you didn't verify"
  decision for RPC endpoints; this ADR applies the same posture to feed identity.
- `docs/security/AUDIT-TOTAL.md` — mainnet address remediation for the 7 entries listed above is
  tracked there as a separate, not-yet-started item. See also: "Staleness policy for remediated feeds with extended heartbeats" above.
