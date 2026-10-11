# ADR-024 — DCA floor price quorum: skip the cycle, never the order

- **Status:** Accepted — owner decisions 2026-10-11 (Proposed → Accepted the same day; implemented
  before any Auditor pass, so **unmerged until an Auditor pass returns 0C/0H** — fund-adjacent)
- **Date:** 2026-10-11
- **Implemented by:** `feat/keeper-price-quorum` (keeper only: `contracts/order-engine/executor/`)
- **Follows:** [ADR-013](ADR-013-order-onchain-floor.md) (the on-chain floor this keeper gate is the
  Phase-0 mitigation for), `SPRINT-ORDER-ONCHAIN-FLOOR / P1a` (`order-floor.js`),
  `CHORE-KEEPER-HARDENING / P1A-M-01` (the transient-vs-feedless fail-open this ADR replaces)
- **Fund-flow:** yes (decides fill-vs-skip for every DCA chunk). No contract, UI or API change.

## Owner decisions (2026-10-11) — verbatim, this is the spec

> DCA floor at execution needs a price QUORUM, per fill, per leg: (A) >= 2 independent sources
> agreeing within QUORUM_TOLERANCE_BPS → normal, floor from the more conservative price. (B) exactly
> 1 source → execute with a tighter floor, fill capped at the existing $ cap (the constant
> order-floor.js already uses; 28b exports it as DCA_NO_PRICE_FILL_CAP_USD — ONE constant), flagged.
> (C) 0 sources, or 2 that disagree beyond tolerance with no third to break the tie → SKIP THIS
> CYCLE: no fill, order untouched, log; after N consecutive skips raise the keeper alert; resume
> automatically when sources return. Never cancel the order, never fill blind.

In one line: **skip the cycle, never the order.**

Scope addition (Architect, owner-approved, 2026-10-11 00:51 WEST), verbatim:

> the no-price fill cap is now a HARD CEILING named DCA_NO_PRICE_FILL_CAP_MAX_USD (the web side
> already pins to order-floor.js's default under that name — keep the value, keep the pin). (a)
> Clamp: if DCA_FAIL_OPEN_MAX_USD is set above the ceiling, the keeper logs a loud warning and uses
> the ceiling; never a value above it. (b) Startup publish: on boot, the keeper upserts one row per
> chain into Supabase `keeper_runtime_config` (chain_id, no_price_fill_cap_usd = the effective
> clamped value, keeper_version, updated_at) using the service client it already has; failure to
> write is logged, never fatal. [...] (c) [...] after restart, `select chain_id,
> no_price_fill_cap_usd from keeper_runtime_config` must show both chains.

## Context

DCA signs `minAmountOut = 1`, so the on-chain per-chunk floor is a 1-wei no-op (ADR-013 §Context).
The keeper's `order-floor.js` gate is the live protection: it rejects a fill whose built output is
below an independent fair-value reference × (1 − `DCA_ORACLE_FLOOR_BPS`). Until this ADR that
reference was **one price per leg** — Chainlink for the ETH leg, else a single DefiLlama read — and
when it was missing the gate split the miss into "transient ⇒ delay" vs "feedless ⇒ fill flagged
under a $250 cap". Two weaknesses:

1. **One source is one point of failure.** A single wrong or manipulated price (a stale DefiLlama
   row, a mis-keyed feed) sets the floor; the gate cannot tell a right price from a wrong one.
2. **"Feedless" was a guess.** The transient/feedless classification inferred whether a feed
   *exists* from HTTP status codes, and the feedless branch filled on no reference at all —
   bounded by the cap, but still blind.

## Decision

### Three independent sources per leg, in trust order (`price-sources.js`)

| # | Source | How | Freshness |
|:--|:--|:--|:--|
| 1 | `chainlink` (on-chain) | OrderExecutorV3 `tokenUsdFeeds(token)` when `registered` (its feed + decimals); else the keeper's **mirror** of `src/lib/chains/chainlink-feeds.ts` for the chain (drift-guarded: address, decimals, pair parsed from the TS by test); the ETH leg still honours the resolved `ETH_USD_FEED` (env wins, verbatim). Integrity: `answer > 0`, `answeredInRound >= roundId`. | `updatedAt` |
| 2 | `defillama` | `coins.llama.fi/prices/current/<slug>:<addr>` — the client the keeper already used, batched once per cycle (≤ 50 tokens/request), 5 s cap | `timestamp` |
| 3 | `coingecko` (new) | `api.coingecko.com/api/v3/simple/token_price/<platform>?contract_addresses=…&include_last_updated_at=true`, no key required (`COINGECKO_API_KEY` optional, demo header), batched once per cycle and cached for the cycle | `last_updated_at` |

Why CoinGecko: nothing already wired prices a token **by contract address independently of
DefiLlama and Chainlink** — the app's multi-source compare is exactly those two, the token-catalog
pipeline uses CoinGecko only for metadata, `/api/token-logo` only for logos, and an aggregator quote
is the thing the floor exists to check. A quote older than `MAX_PRICE_AGE_SEC`, or with no
timestamp, is **absent** — never stale-but-counted. Every I/O is injected; the tests run with a
`globalThis.fetch` tripwire.

### The quorum (`order-floor.js` `resolveFloorPrice(leg, quotes)`), pure

| sources that answered (fresh, one per source) | mode | price used | what the executor does |
|:--|:--|:--|:--|
| ≥ 2 and every pair within `QUORUM_TOLERANCE_BPS` | `quorum` | conservative over the agreeing set | normal floor, `DCA_ORACLE_FLOOR_BPS` band |
| 3, exactly one pair agrees | `quorum` | conservative over the pair; outlier dropped (the third breaks the tie) | normal floor |
| 3 in a chain (A~B, B~C, A≁C) | `quorum` | the pair with the most-trusted members | normal floor |
| exactly 1 | `single` | that price | **tighter** band (`singleSourceFloorBps` = half, never below the MIN clamp) + fill ≤ the no-price $ cap + flagged alert; a chunk **above** the cap is **delayed** and counted in the skip streak (Auditor round 1, M — §Consequences) |
| 0 | `skip` | — | **skip this cycle**: unlock to `active`, bump `consecutiveSkips`, log; alert at `SKIP_ALERT_CYCLES` (and every N); never cancel, never execute |
| 2 that disagree beyond tolerance, no third | `skip` | — | same |
| 3, no pair agrees | `skip` | — | same |

"More conservative" is leg-relative and always the **protective** side for a floor: the `in` leg
(what the user sells) takes the highest valuation, the `out` leg (what the user receives) the
lowest — both raise the floor. A fill is `skip` if **either** leg is `skip`, `single` if either leg
is `single`, else `quorum` (`combineLegModes`). A resolved pair whose reference cannot be computed
(amount/decimals/precision) is a skip too. The per-order streak counts every cycle the price
machinery holds the fill back — a quorum skip **or a single-source cap-delay** (Auditor round 1, M)
— and resets once it *releases* the fill (quorum, or single within the cap) and on any successful
fill; it is dropped on expiry and in-memory only (a restart starts at 0). A floor breach is a
route-quality rejection with its own per-cycle WARN: it neither bumps nor resets the streak.

### Constants — one production module (`order-floor.js`), env-overridable **by name**, clamped

| constant | default | env (same name) | clamp |
|:--|:--|:--|:--|
| `QUORUM_TOLERANCE_BPS` | 300 | `QUORUM_TOLERANCE_BPS` | [10, 2000] |
| `MAX_PRICE_AGE_SEC` | 600 | `MAX_PRICE_AGE_SEC` | [30, 86400] |
| `SKIP_ALERT_CYCLES` | 3 | `SKIP_ALERT_CYCLES` | [1, 1000] |
| `DCA_ORACLE_FLOOR_BPS` (unchanged) | 300 | `DCA_ORACLE_FLOOR_BPS` | [50, 2000] |
| `DCA_FAIL_OPEN_MAX_USD` (unchanged literal; the single-source cap) | 250 | `DCA_FAIL_OPEN_MAX_USD` | [0, **`DCA_NO_PRICE_FILL_CAP_MAX_USD`**] |
| **`DCA_NO_PRICE_FILL_CAP_MAX_USD`** (scope addition) | **250** | — (not overridable) | hard ceiling |
| `PRICE_SOURCE_TRUST_ORDER` | chainlink › defillama › coingecko | — | tie-break only |

Scope addition, as implemented: `DCA_NO_PRICE_FILL_CAP_MAX_USD` is the **hard ceiling** on the
single-source cap. The web side (28b, `src/lib/order-engine/dca-floor-tier.ts`) pins its constant of
the same name to the `DCA_FAIL_OPEN_MAX_USD = 250` literal by source regex *and* imported value, so
that literal is untouched and a keeper test pins the two equal. `resolveFailOpenMaxUsd(env)` returns
`{ value, clamped, source, reason }`; an env above the ceiling is clamped down with a `console.warn`
plus a log line at boot, never honoured. `DCA_FAIL_OPEN_MAX_USD_MAX` (was 100 000) now equals the
ceiling and stays exported. At boot the keeper upserts `keeper_runtime_config` (`chain_id` PK,
`no_price_fill_cap_usd` = the effective clamped value, `keeper_version` = `KEEPER_VERSION` env else
`package.json` name@version, `updated_at`) through its existing service-role `supabaseFetch`
(`runtime-config.js`): logged, never fatal, and tolerant of the table not existing yet — it is
created by the 28b migration `20261011120000_orders_floor_tier_consent.sql`, which is **not merged**
as of this ADR.

### What is deliberately NOT changed

No V3 / contract change; no UI or API change; the cap **value** is unchanged (250); no new secret
(`COINGECKO_API_KEY` is optional and keyless works); `classifyReference` / `decideFailOpen` are
retained as pure exports (no longer called by the executor) rather than deleted (rule #4).

## Consequences

- **Delay ≫ drain, now also ≫ guess.** A leg the keeper cannot price from two independent places
  is not filled this cycle. DCA buys later, never blind. The order is never cancelled.
- **Stablecoin Chainlink feeds with long heartbeats** (Base USDC/USD: 24 h, 0.3 % deviation) will
  often be *absent* under `MAX_PRICE_AGE_SEC = 600`; the quorum for those legs then rests on
  DefiLlama + CoinGecko. Arbitrum USDC/USD (255 s) is unaffected. Raise `MAX_PRICE_AGE_SEC` per
  instance if an Auditor prefers the on-chain leg to count for stables.
- **Protective conservative pick compresses the band near tolerance:** two legs each at a 3 %
  spread can lift the reference by ~6 % and reject a legitimate fill until the sources converge.
  That is a delay, not a drain, and spreads that wide signal a moment not to fill.
- **Three requests per cycle, not per order** (one DefiLlama batch, one CoinGecko batch, one
  Chainlink read per token), so the keyless CoinGecko tier is comfortably within limits.
- **A 28b-consented pair can land in `single` mode and be capped/delayed** (Auditor round 1, M,
  2026-10-11). 28b classifies a pair at *creation* (`onchain-feed` / `offchain-price` / `unpriced`)
  and today counts only DefiLlama as its off-chain source; the keeper decides at *execution* over
  three sources. So a pair the user consented to as priced can, on a given cycle, have exactly one
  fresh source on a leg → `single` → and if the chunk's notional exceeds the no-price cap
  (`getFailOpenMaxUsd()`, ≤ `DCA_NO_PRICE_FILL_CAP_MAX_USD` = 250) it is **delayed**, not filled.
  Before this round that delay was an info alert (score 0) every cycle with no streak, so a
  persistently one-sourced order above the cap could stall silently. Now a cap-delay is **a skip
  for streak purposes**: it bumps the same per-order streak, the `dca-floor-delay` alert escalates
  to WARN at `SKIP_ALERT_CYCLES` (and every N) with the count, and the streak resets only when the
  fill is released or succeeds (wiring pinned by `price-quorum-wiring.test.mjs` §4/§4b). The order
  is still never cancelled; it resumes when a second source returns, the chunk shrinks, or the cap
  is raised (never above the ceiling). The 28b tier ↔ quorum-mode mapping that would make the
  consent and the execution agree is the open TODO at `order-floor.js` `resolveFloorPrice`.
- **Both keepers must be restarted** to pick this up (Base `teraswap-executor`, Arbitrum
  `teraswap-keeper-arbitrum`); the quorum line `DCA price quorum: in=… out=… -> …` in the log is
  the proof it is live.

## Verification

- `contracts/order-engine/executor`: `node --test` — 736 tests (origin/main 650; 731 before the
  Auditor round-1 follow-up), 0 fail: `price-sources.test.mjs` (29, drift guard + sources, zero
  network), `order-floor.test.mjs` (+24: the table above, tie-break, boundary, env-by-name),
  `price-quorum-wiring.test.mjs` (18: the skip branch ends in `continue` before any execution-path
  call, touches no write / ladder / cancel, only ever unlocks to `active`; §4b: a cap-delay bumps
  the shared streak, escalates at `SKIP_ALERT_CYCLES`, ends in `continue`; the reset follows the
  cap check; a breach neither bumps nor resets), `runtime-config.test.mjs` (12: clamp both
  directions, tolerant upsert, boot wiring).
- Mutation run: 18 rules flipped in place (tolerance, conservative pick, single-as-quorum, skip
  leg, stale counted, cap value, `continue` removed, alert cadence, reset-on-success, tie-break,
  tighter band, cancel-instead-of-unlock, 0-as-single, V3 registry ignored, ceiling clamp; round-1
  follow-up: cap-delay streak bump removed, cap-delay alert never escalates, reset moved back before
  the cap check) — each caught by a named test; files restored and verified byte-identical. Table
  in `docs/feedback/feat-keeper-price-quorum.md`.
