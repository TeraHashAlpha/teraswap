# SPEC: Basket DCA (phase 1, Base)

> Source: ADR-027; owner decisions 2026-11-07; analyst package v3.1 (`engine_discrete.py` is the reference implementation). Fund-flow: yes, Auditor before merge of §4, §5, §6. Contract: untouched. Facts below were read in the repo at `7e566fd` and on-chain on 2026-11-13; an agent re-checks any fact it builds on.

## 1. Product, in the user's words

"Pick three tokens and a split. Each cycle we buy the one that fell most. At the end, the split is exactly the one you chose."

Copy rules (binding): the split you ask for is fulfilled; about one purchase per cycle; protections. Never "buys at the best time", never "cheaper", never a risk-profile name for a split. History is never a promise.

## 2. Phase 1 scope

| Item | Value |
|---|---|
| Chain | Base (8453) |
| Token sold | USDC |
| Legs | exactly 3, different, each registered in `tokenUsdFeeds` on the Base executor (read on-chain 2026-11-13): WETH, cbBTC, VIRTUAL, COMP, and one stable leg at most, USDT or DAI. Read from the executor feed registry, never a typed list |
| Stable leg | owner decision 2026-11-13: phase 1 must offer one (a user may want only ETH, cbBTC and a stable). Peg band of §4a applies |
| Token list copy | the interface says plainly which tokens are available today, and: "New tokens are added every month." (owner, 2026-11-13) |
| Splits | 25-25-50, 40-40-20, 33-33-33, 30-30-40 (shown as numbers) |
| Cadence `T` | daily, every 3 days, weekly |
| Cycles `N` | minimum 6; maximum set by `(N + 3) × T + margin ≤ 90 days` (86 daily, 26 every 3 days, 9 weekly) |
| Rule 9 | per leg, threshold 25% by default, user-configurable; soft mode by default; rigid mode behind a warning with real numbers |
| Fee | 0.1% per purchase, charged by the contract as today |

Out of phase 1: EURC (euro peg, the band is defined against 1 USD), AERO and other tokens with no registered feed, Arbitrum, mainnet.

## 3. The three signed orders

For capital `C` (USDC, in token units), weights `w_i`, `N`, `T`, start time `t0` (server time at creation):

1. `amountIn_i = floor(w_i × C)` for legs 1 and 2; leg 3 takes `C − amountIn_1 − amountIn_2`. For 33-33-33 the weights are thirds, not 0.33.
2. `n_i` (the leg's `dcaTotal`): `floor(w_i × N)`; hand the units missing to reach `N` to the largest remainders (ties: lower leg index); then `n_i = max(n_i, 1)`; then `n_i = min(n_i, max(1, floor(w_i × C_usd ÷ minFill)))`.
3. `minFill` = 3 USD when the leg's signed router is the canonical route, 16 USD otherwise. Values from the owner decisions of 2026-11-07; they are the sizes at which the 0.1% fee equals the gas of a fill measured on Base (0.003 and 0.016 USD). One constant pair, exported once, used by API and UI.
4. `dcaInterval = T ÷ 2` for every leg.
5. `expiry = t0 + (N + 3) × T + 3 600 s`.
6. Everything else (router, `routerDataHash`, `minAmountOut`, `maxSlippageBps`, nonce) is derived exactly as a single-token DCA order is today.

One approval of USDC for `C` covers the three orders. Three signatures.

## 4. Selection rules (keeper), per basket, per tick

Ticks happen at `t0 + t × T`, `t = 0 … N + 2` (`N` nominal cycles and 3 grace cycles). Each tick has a second slot at `+ T ÷ 2`.

State per leg: `done_i` (chunks executed, from the order row), `last_i` (decision price at the previous tick with a price), `entry_i` (decision price at the first tick with a price), `peak_i` (reporting only). State per basket: `cooldown` (the leg that took the first chunk of the previous tick).

At tick `t`:

1. **Price `P_i`**: the ADR-024 resolved price of the leg (Chainlink no older than 600 s, else the quorum). No usable price: the leg is out of this tick ("no price").
2. **Variation** `v_i = P_i ÷ last_i − 1`. At tick 0 there is no previous price: every `v_i` is 0 and the tie rule decides (pinned by the vectors).
3. **Protected (rule 9)**: `P_i ≤ entry_i × (1 − threshold)`. In soft mode protection stops blocking when `t ≥ N − k_soft` and in grace cycles; in rigid mode it always blocks. `k_soft` is a function of `N`, **pending the analyst's v3.2** (the modelled value, 10, would never block a basket of 10 cycles or fewer); it is one exported function, so the result drops in.
4. **Eligible**: not complete (`done_i < n_i`), has a price, not blocked by rule 9, and for the stable leg inside the band (§4a).
5. **Due**: `due_total = M` if `t ≥ N − 1`, else `min(M, ceil(M × (t + 1) ÷ N))`, with `M = Σ n_i`; `due = due_total − Σ done_i`.
6. **First chunk (rule 4)**: the eligible leg with the lowest `v_i` (signed minimum); tie: the leg furthest behind its own count (`(n_i − done_i) ÷ n_i`, highest first). **Rule 5**: if that leg is `cooldown` and another leg is eligible, `cooldown` goes to the back of the line.
7. **Catch-up**: while fewer than `due` chunks are picked, add the eligible leg furthest behind its own count (tie: lowest `v_i`), never more than 2 chunks of one leg in the tick and never beyond `n_i`.
8. **Execution**: each leg's first chunk of the tick is submitted in the first slot; a second chunk of the same leg in the `+ T ÷ 2` slot (the contract refuses it earlier).
9. After the tick: `cooldown` = the leg of the first chunk (none if nothing was picked); `last_i = P_i` for every leg that had a price.
10. A tick with no purchase records why, in this priority: calendar (nothing due), all complete, no price, rule 9, rule 5.

A chunk that was picked and did not execute (no route, floor, revert, infra) stays due: the calendar counts executed chunks, so the next tick picks it up. ADR-024 and ADR-026 apply unchanged to each leg order: a skipped cycle or an infra miss never counts against the order.

### 4a. Peg band (stable leg only)

Band 1% by default; the user may widen it up to 10% without a warning; above 10% one warning, read from `results/v31/aviso_banda.csv` (three wording rules, D = 2 137 days); if the user refuses, the basket is not created (server error, not only interface). The stable's own USD feed is accepted up to its `maxStaleness`; the leg is out of band when `|p − 1| + feed deviation threshold > band`; otherwise the quorum price decides; no price, the leg skips the tick. The deviation thresholds of the USDT/USD and DAI/USD feeds on Base come from the analyst's v3.2, never typed from memory. The token sold never pauses. An out-of-band tick records "band" as the reason, after "no price" and before rule 9.

**Reference and acceptance.** The rules above are `engine_discrete.run_discrete` with `L = 2`, `rule = 'hamilton'` and the `k_soft` rule of v3.2. The implementation is a pure module with no I/O. Its test suite replays test vectors exported from the Python engine (the 4 splits × 3 cadences, one strong-fall scenario, one no-price scenario, one rigid-mode scenario, one stable-out-of-band scenario, one restart mid-basket) and must match pick for pick. In soft mode the vectors must show deviation 0.00 pp on completed baskets; rigid-mode vectors show unbought chunks and are asserted as such, not as failures. Until this suite is green in the repo, the sentence "the split you ask for is fulfilled" does not appear in the product.

## 5. Data

New table `baskets`: id, wallet, chain_id, token_in, capital, cadence_s, cycles, t0, mode, threshold_bps, band_bps, band_ack_at, status, created_at, and for each of the 3 legs: token_out, weight (numerator, denominator), n, order_hash. New column `orders.basket_id` (null for every existing order).

New table `basket_ticks` (the decision journal, one row per basket per tick, written BEFORE any transaction of that tick is sent): basket_id, tick index, decided_at, and per leg: price, price source, variation, eligibility reason, chunks picked; plus the first-chunk leg and the idle reason. Unique on (basket_id, tick). A restarted keeper reads the row and continues; it never decides the same tick twice.

No visitor data beyond what the orders already hold. Row-level security as for `orders`.

## 6. Keeper

- A leg order (`basket_id` not null) is **never** executed by the ordinary DCA due-time path. It executes only when the journal row of the current tick picked it. This check sits before the lock and is fail-closed: basket row missing or unreadable means no execution.
- The keeper publishes `basket_capable = true` in `keeper_runtime_config` for its chain at boot (same mechanism as `no_price_fill_cap_usd`).
- A missed tick (keeper down) is not replayed: the next tick's calendar and the 2-per-leg limit do the catching up.
- Leg orders keep every existing gate: router constraint, deviation guard, oracle floor, freeze flag, retry ladder, redaction of logs and alerts.
- One Telegram alert per new basket, not three.

## 7. API

- `POST /api/baskets`: body = basket parameters + the three signed orders. The server recomputes §3 from the parameters and rejects (400) any order whose signed fields differ; verifies the three signatures; checks every leg and the token sold against the executor feed registry (403 otherwise); checks `basket_capable` for the chain and a server flag `BASKET_DCA_ENABLED` (503 otherwise); honours the DCA freeze flag; inserts the basket and its three orders atomically (all or none). Rate-limited with `checkRateLimitWithin`.
- Basket legs do not go through `POST /api/orders`; that route keeps its 2-365 rule.
- `GET /api/baskets?wallet=`: baskets with legs, progress and the journal, under the same read authorisation as orders.
- Cancel: marks the basket and its three orders cancelled in the database at once (the keeper stops), and returns the three orders for the on-chain `cancelOrder` calls. The interface says plainly that on-chain cancellation is three transactions, and offers revoking the USDC approval as the one-transaction alternative, with its side effect on other open orders.

## 8. Later (specified, not built in phase 1)

- **More tokens, monthly batch (owner, 2026-11-13)**: the repo keeps a list of candidates (weekly job, read-only); once a month the owner chooses, a PR enables the rows and an Auditor reads it, and the owner sends the two admin transactions per token from `docs/Runbooks/dca-feed-registration.md` (queue, 48 h, execute within 7 days). A registered token appears as a possible leg by itself, because the leg list is read from the executor. Batch 1 (Base): AERO, cbETH, MORPHO, ZRO, YFI.
- **EURC** as a leg: needs a band defined against EUR/USD.
- **Arbitrum.**

## 9. Interface (v1 and v2 together)

- Create: three tokens, split, amount, cadence, cycles, protection (threshold, mode). A summary before signing: per leg the total, the chunk, the number of purchases; the end date including the 3 extra cycles; "three signatures".
- Rigid mode: a warning with real numbers from the analyst package (about 22 to 24% of modelled positions ended incomplete).
- Card per basket: split asked against split so far, next cycle, per-leg state (buying, paused by protection, no price, complete).
- **Closing report**: split asked and fulfilled; purchases with transaction links; cycles with no purchase and why; legs not fully bought and why, with the still-active approval and a revoke action; fee and number of purchases. Never "what you would have earned".
- Fiat values are display only.

## 10. Order of work (each line one goal, one PR)

1. Docs (Haiku): analyst package to `docs/Reports/basket-dca/`, this spec and ADR-027 into the repo, the stale notes (ADR-015, ADR-024 "255 s", fee 0.20% in FILL-ECONOMICS-CALIBRATION, Arbitrum state in DEPLOYMENTS.md).
2. Selection module + test vectors (Opus): pure module in the keeper folder, vectors exported from the Python engine. No keeper wiring. Starts when v3.2 is delivered.
3. Data + keeper wiring (Opus), then **Auditor**.
4. API (Sonnet), then **Auditor** (same pass as 3 if both are ready).
5. Interface v1 + v2 (Sonnet), behind `BASKET_DCA_ENABLED`.
6. Owner: keeper rollout on the host, then the flag.

## 11. Do NOT

Change the contract. Execute a leg outside a journal decision. Let a basket be created on a chain whose keeper has not published the capability. Show a performance claim. Type a token or feed address by hand.
