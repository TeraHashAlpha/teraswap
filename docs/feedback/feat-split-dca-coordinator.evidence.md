# feat/split-dca-coordinator — evidence (long tables)

Companion of `feat-split-dca-coordinator.md`. Sections are numbered as the goal's evidence items.

## 2 Schema: each column and its reason

Migration `supabase/migrations/20261116120000_baskets_split_dca.sql`, mirrored statement for statement in
`contracts/order-engine/schema.sql`. "§5" = SPEC-BASKET-DCA §5; "rule" = a Coordinator rule of §4.

### `baskets` (new table)

| Column | Type | Reason |
|---|---|---|
| `id` | UUID PK, `gen_random_uuid()` | §5. The key `orders.basket_id` and `basket_ticks.basket_id` point at |
| `created_at` | TIMESTAMPTZ NOT NULL, `now()` | §5 |
| `wallet` | TEXT NOT NULL, lowercase `0x` + 40 hex | §5. The owner; a leg order must have the same owner (rule "fail closed": owner). Lowercase so it equals `orders.wallet` and the wallet claim of the read policy |
| `chain_id` | INTEGER NOT NULL | §5. The keeper polls its own chain; a leg order must be on the same chain (rule "fail closed": chain) |
| `token_in` | TEXT NOT NULL, lowercase address | §5. The token sold; a leg order must sell it (rule "fail closed": token) |
| `capital` | TEXT NOT NULL, digits | §5. `C` in raw units, text like `orders.amount_in`. Not read by the coordinator (the API and the closing report use it) |
| `cadence_s` | INTEGER NOT NULL, > 0 and even | §5. `T`: the tick times and, as `T / 2`, the second slot and the reference deadline (rules "modes", "slot timing"). Even so `T / 2` is whole seconds, as the legs' `dcaInterval` is |
| `cycles` | INTEGER NOT NULL, 1 … 10 000 | §5. `N`: ticks are `0 … N + 2`; the calendar and `k_soft` of the selection module |
| `t0` | BIGINT NOT NULL, > 0 | §5. Start in unix seconds: the unit of `orders.expiry`, which the API derives from it, and of the keeper's injected clock. No timestamp parsing in the tick arithmetic |
| `first_buy` | TEXT NOT NULL, default `'reference'`, `'reference'` or `'now'` | The goal, and rule "modes": where tick 0 is, and whether a reference row is taken |
| `mode` | TEXT NOT NULL, `'soft'` or `'rigid'` | §5. Rule 9's mode, passed to the selection module |
| `threshold_bps` | INTEGER NOT NULL, 1 … 9 999 | §5. Rule 9's threshold. Above 0 (Coordinator rules, last but one): at 0 every leg is paused at its first price |
| `stable_leg` | SMALLINT, 0, 1, 2 or NULL | NOT in §5; needed by the rule "the stable leg's price and bandAdd come as a pair": the coordinator has to know WHICH leg that is, and the selection module takes `stableLeg`. NULL = no stable leg |
| `band_bps` | INTEGER, 1 … 9 999, NULL exactly when `stable_leg` is NULL | §5. The peg band (§4a), passed to the selection module |
| `band_ack_at` | TIMESTAMPTZ | §5. When the user accepted a band above 10% (§4a). Not read by the coordinator |
| `status` | TEXT NOT NULL, default `'active'`: `active`, `completed`, `expired`, `cancelled` | §5, rule "status". The coordinator writes `completed` and `expired`; `cancelled` is the API's (§7) |
| `leg0_token_out`, `leg1_…`, `leg2_…` | TEXT NOT NULL, lowercase address, three different, none = `token_in` | §5, and "the leg ORDER" of the goal: the leg index is in the column name. The selection rules break ties by leg index, and in `'now'` mode leg 0 is the token the user chose. Matched against the leg order (rule "fail closed": token) |
| `leg0_weight_num`, `leg0_weight_den` (× 3) | INTEGER NOT NULL; positive, no leg above 50%, sum exactly 1 | §5 (numerator, denominator: thirds are thirds). Not read by the coordinator; the API recomputes §3 from them and the closing report shows the split asked |
| `leg0_n` (× 3) | INTEGER NOT NULL, 1 … 10 000 | §5. The leg's chunk count, its order's `dcaTotal`: the selection module's `n`, and matched against the leg order (rule "fail closed": n) |
| `leg0_order_hash` (× 3) | TEXT NOT NULL, `0x` + 64 hex, three different | §5. Which order row is which leg: the coordinator places the three rows by this hash, not by their order in the query |

Indexes: `idx_baskets_chain_active (chain_id, created_at) WHERE status = 'active'` (the keeper's poll),
`idx_baskets_wallet (wallet)` (`GET /api/baskets?wallet=`).

### `orders.basket_id` (new column on an existing table)

| Column | Type | Reason |
|---|---|---|
| `basket_id` | UUID, NULL, no default, `REFERENCES baskets(id) ON DELETE RESTRICT` | §5: NULL for every existing order. §6: an order with a basket never takes the ordinary DCA path. The coordinator requires each leg row to carry its basket's id |

Index: `idx_orders_basket_id (basket_id) WHERE basket_id IS NOT NULL` (partial: it holds leg orders only).

### `basket_ticks` (new table, the decision journal)

| Column | Type | Reason |
|---|---|---|
| `id` | UUID PK | Row identity (the natural key is the unique pair below) |
| `created_at` | TIMESTAMPTZ NOT NULL, `now()` | The DATABASE's clock when the row arrived; beside `decided_at` it shows a keeper clock that is off |
| `basket_id` | UUID NOT NULL, `REFERENCES baskets(id) ON DELETE RESTRICT` | §5. RESTRICT: a journal of fund-flow decisions must not vanish with its basket |
| `tick` | INTEGER NOT NULL, ≥ -1 | §5 "tick index"; the goal: -1 = the reference row |
| `decided_at` | TIMESTAMPTZ NOT NULL | §5. The keeper's injected clock at the decision |
| `leg0_price`, `leg1_price`, `leg2_price` | DOUBLE PRECISION, NULL = no usable price; positive and finite | §5 "price"; rules for the wiring: "stored as double precision, never rounded". `last` and `entry` of the next ticks are read from these columns (rule "state rebuilt from rows") |
| `leg0_price_source` (× 3) | TEXT, set exactly when the price is | §5 "price source"; rule "the journal stores … its source". A short label from a closed alphabet (no `/`), checked by the coordinator, so a URL cannot be journaled |
| `band_add` | DOUBLE PRECISION, ≥ 0, NULL without a stable price | The goal; rule "stable pair": the other half of the stable leg's price (§4a) |
| `per_leg` | JSONB array, NULL on the reference row | The goal: the module's `perLeg` as returned (`variation`, `protected`, `inBand`, `reason` per leg). §5 "variation, eligibility reason". Never recomputed, never read back for a decision |
| `picks` | JSONB array, NULL on the reference row, `[]` = nothing picked | The goal: "the picks with slot" (`leg`, `kind`, `slot`), in decision order. §5 "chunks picked" and "the first-chunk leg" (`picks[0].leg`). The second slot executes from here |
| `next_state` | JSONB object, NULL on the reference row | The goal: the module's `next`. `cooldown` is read by the next tick (rule "state rebuilt from rows"); `legs[i].done` is the executed count at the decision, which tells an executed pick from one still due (rule "slot timing") |
| `idle_reason` | TEXT, one of the module's six `IDLE_REASONS`, NULL when something was picked | §5 and the goal: "the idle reason" |

Constraints: `UNIQUE (basket_id, tick)` (the goal; what makes "decide once" hold between two processes);
`basket_ticks_row_shape`: tick -1 has no decision columns, tick ≥ 0 has all of them.

### Row level security

| Table | Enabled | Policies | `orders`, for comparison |
|---|---|---|---|
| `baskets` | yes | SELECT own rows, on `wallet = lower(current_setting('request.jwt.claims', true)::json->>'wallet_address')` | the same SELECT; plus INSERT own and UPDATE own-active-to-cancelled |
| `basket_ticks` | yes | SELECT rows of own baskets (subquery on `baskets`) | `order_executions`: SELECT rows of own orders |

No INSERT, UPDATE or DELETE policy on either table: see "Concern" in the feedback file.

## 3 The coordinator's decision table

`coordinateBasket({ basket, orders, inFlight }, { now, db, resolvePrice })` in
`contracts/order-engine/executor/basket-coordinator.js`. One call = one poll of one basket. It never throws.

### 3.1 Times (all unix seconds; `T` = `cadence_s`, `N` = `cycles`)

| | `first_buy = 'reference'` | `first_buy = 'now'` |
|---|---|---|
| Reference row (journal tick -1) | written at first sight if `now < t0 + T/2`; never later | never |
| Tick `t`, `t = 0 … N + 2` | `t0 + (t + 1) × T` | `t0 + t × T` |
| Slot 1 / slot 2 of tick `t` | tick time / tick time `+ T/2` | the same |
| Tick `t` is current (decidable, its picks executable) | from its tick time until the next tick's time | the same |
| End (the last grace tick's window closes) | `t0 + (N + 4) × T` | `t0 + (N + 3) × T` |

### 3.2 One poll, in order (the first row that applies ends the poll)

"FC" = fail closed (`result.failClosed`): something is wrong; nothing executes for this basket in this poll.

| # | When | Reads | Writes | Picks | `reason` |
|---|---|---|---|---|---|
| 1 | `deps.now`, `deps.resolvePrice` or a `deps.db` method is missing; the input is not an object | - | - | none | `internal_error` FC |
| 2 | the basket row is null or undefined | - | - | none | `basket_missing` FC |
| 3 | a field of the basket row is missing or out of range (id, wallet, chain_id, token_in, cadence_s even, cycles, t0 in seconds, first_buy, mode, threshold_bps 1 … 9 999, stable_leg explicit, band_bps with it, status, the three legs' token, n, order hash; two legs alike; a leg buying the token sold) | - | - | none | `basket_unreadable` FC |
| 4 | `status` is not `active` | - | - | none | `basket_not_active` |
| 5 | not exactly three order rows; a leg with no row carrying its order hash; a row whose basket_id, type, chain, wallet, token_in, token_out, dca_total or dca_executed (0 … n) does not match; the same for owner, tokenIn, tokenOut, dcaTotal of the signed `order_data` | - | - | none | `orders_mismatch` FC |
| 6 | `inFlight` is not an array, or an entry names no leg of this basket | - | - | none | `in_flight_unreadable` FC |
| 7 | `now()` throws or is not a plausible number of unix seconds (milliseconds are refused) | - | - | none | `clock_invalid` FC |
| 8 | every leg has `dca_executed ≥ n` | - | `baskets.status = completed` | none | `completed` (`status_write_failed` FC if the write is not confirmed) |
| 9 | `now ≥ end` and a leg is in flight | - | - | none | `in_flight` |
| 10 | `now ≥ end` | - | `baskets.status = expired` | none | `expired` (`status_write_failed` FC) |
| 11 | the journal cannot be read; a row is malformed, another basket's, or beyond the last grace tick; a tick twice; a reference row in `'now'` mode | journal | - | none | `journal_unreadable` FC |
| 12 | the journal holds a tick later than the clock's current tick | journal | - | none | `clock_behind_journal` FC |
| 13 | before the first tick, `'reference'` mode, no reference row, `now < t0 + T/2` | journal, 3 prices | row tick -1 (prices, sources, band_add; nothing else) | none | `reference_recorded` (`price_error` or `journal_write_failed` FC) |
| 14 | before the first tick, anything else | journal | - | none | `before_first_tick` |
| 15 | the current tick has a row | journal | - | § 3.4 | § 3.4 |
| 16 | the current tick has no row and a leg is in flight | journal | - | none | `in_flight` |
| 17 | the current tick has no row | journal, 3 prices | row of the current tick: the decision | § 3.4, from the row as stored | § 3.4 (`price_error`, `decide_error` or `journal_write_failed` FC: nothing written) |

A tick other than the current one is never decided: there is no row 15-17 for a past tick.

### 3.3 The state the selection module gets at tick `c` (row 17)

| Input of `decideTick` | From |
|---|---|
| `params.cycles`, `mode` | `baskets.cycles`, `mode` |
| `params.threshold`, `band` | `threshold_bps ÷ 10 000`, `band_bps ÷ 10 000` (the double of the decimal) |
| `params.stableLeg` | `baskets.stable_leg` |
| `tick` | `c`, from the clock |
| `legs[i].n` | `baskets.leg{i}_n` (= the order's `dca_total`, checked) |
| `legs[i].done` | the order row's `dca_executed`, never the picks |
| `legs[i].last` | the price of leg `i` in the latest journal row before `c` that has one, the reference row included |
| `legs[i].entry` | the price of leg `i` in the first TICK row (tick ≥ 0) that has one; the reference row never |
| `cooldown` | `next_state.cooldown` of the row of tick `c - 1`; none if that tick has no row, or `c = 0` |
| `prices[i]` | `resolvePrice(leg token, { stable })`: a positive finite price with a source label, or no price |
| `bandAdd` | the stable leg's answer carries it with the price (a price without it: `price_error`); 0 when the stable leg has no price; not passed without a stable leg |

### 3.4 Which picks of the current tick's row are executable now (rows 15 and 17)

First: if any leg's `dca_executed` is LOWER than the `done` stored in the row, `orders_mismatch` FC.

For each pick of the row, in decision order, with `executed = dca_executed now - done stored in the row` for its leg:

| The pick | Outcome |
|---|---|
| `slot ≤ executed` | already executed: skipped |
| a lower slot of the same leg is still outstanding | not offered (one pick per leg per poll: its next outstanding slot) |
| its leg is in flight (the caller's list, or the order row is `executing`) | waits |
| `now <` tick time `+ (slot - 1) × T/2` | waits |
| otherwise | executable: `{ orderId, leg, tick, slot, kind }` |

When no pick is executable: `tick_idle` (the row picked nothing; the detail carries the module's idle reason),
else `in_flight` (a pick waits for a transaction), else `slot_not_reached` (a second slot waits for its time),
else `picks_executed`.

### 3.5 What "fail closed" leaves behind

In rows 1-7, 11, 12 nothing is read beyond what the row says and nothing is written. In rows 13 and 17 a failure
before or during the write leaves no row, so the next poll starts from the same state; a write the database refuses
(another keeper's row for the same tick) leaves THAT row, which the next poll reads. The reason is returned to the
caller (`result.reason`, `result.detail`), not journaled: a journal row for (basket, tick) IS the decision and exists
at most once, so writing a failure there would stop the next poll from deciding.
