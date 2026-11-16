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

## 4 Mutation proof

Rig (outside the repo, in the session scratchpad): the files the test needs are copied into a scratch tree with the
same relative layout (`basket-coordinator.js`, its test, `basket-scheduler.js`, `executor.js`, `package.json`, the
fixtures, `schema.sql`, the migration); for each mutant `basket-coordinator.js` is rewritten there with exact string
replacements, each required to occur exactly once, and `node --test basket-coordinator.test.mjs` runs with a reporter
that prints one line per failing test (suites are not counted). The unmutated copy is run first.

| | Baseline | Mutants | Killed | Survived | Not applied |
|---|---|---|---|---|---|
| Node 22.23.5 | 458 pass, 0 fail | 83 | 83 | 0 | 0 |
| Node 20.20.2 | 458 pass, 0 fail | 83 | 83 | 0 | 0 |

The two Node versions fail exactly the same tests for every mutant. Counts below are Node 22.23.5's.

### 4.1 The goal's five, with every rule test that fails (vector replays are counted, not listed)

**G1a, decide twice: the current tick's row is ignored and the tick is decided again.** 395 of 458 tests fail, 384 of them vector replays. By name:

- `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed`
- `restart between the row write and the execution: the stored picks come back, nothing is decided again`
- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `slot 1 from the tick time; slot 2 before its time is not executable, at its time it is`
- `a leg's second slot is never offered while its first has not executed, whatever the time`
- `an executed pick is not offered again`
- `a pick is executable until the next tick's time and not after: the next tick decides anew, and the chunk is due again`
- `inside a tick, a leg in flight is not offered again; the other legs are`
- `order rows that show fewer executed chunks than when the tick was decided: nothing executes, on a picked leg or any other`
- `the last grace tick's second slot is executable at + T / 2, before the basket expires`
- `the same poll twice over the same rows gives the same answer (a row read back is never decided again)`

**G1b, decide twice: the tick is decided again and the refused duplicate write is swallowed (the new decision executes).** 168 of 458 tests fail, 158 of them vector replays. By name:

- `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed`
- `restart between the row write and the execution: the stored picks come back, nothing is decided again`
- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `journal write failure: nothing executes and nothing is reported as written; the next poll decides`
- `slot 1 from the tick time; slot 2 before its time is not executable, at its time it is`
- `an executed pick is not offered again`
- `inside a tick, a leg in flight is not offered again; the other legs are`
- `order rows that show fewer executed chunks than when the tick was decided: nothing executes, on a picked leg or any other`
- `it never throws and never returns a pick, whatever it is given`
- `the last grace tick's second slot is executable at + T / 2, before the basket expires`

**G2a, return before writing: the decision is never written; the picks come from memory.** 425 of 458 tests fail, 385 of them vector replays. By name:

- `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys first`
- `reference row: a leg with no price at first sight has no reference, and gets its last at its first tick with a price`
- `'now' mode with leg 0 unpriced: no special case, the first chunk goes to the next leg and the journal says why`
- `'now' mode with leg 0 the stable leg and out of its band: the first chunk goes to the next leg (reason band)`
- `'reference': the coordinator decides tick t in [tick time, next tick time) and nothing a second earlier`
- `'now': the coordinator decides tick t in [tick time, next tick time) and nothing a second earlier`
- `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown…`
- `entry is the first TICK row's price, never the reference row's: 30% under the reference at the first tick is not protected`
- `the basket's basis points reach the module as bps ÷ 10 000, the double of the decimal: a price exactly on entry × (1 − 0.57) is protected`
- `the band reaches the module as bps ÷ 10 000 too: a sum one step above 6% is out of a 6% band`
- `the journal rows may come back in any order: the state is the same`
- `done comes from the order rows, never from the picks: a pick that did not execute is due again by the calendar`
- `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed`
- `restart between the row write and the execution: the stored picks come back, nothing is decided again`
- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `journal write failure: nothing executes and nothing is reported as written; the next poll decides`
- `the row is in the database before the call returns, and the picks are read from the row AS STORED`
- `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
- `slot 1 from the tick time; slot 2 before its time is not executable, at its time it is`
- `a leg's second slot is never offered while its first has not executed, whatever the time`
- `an executed pick is not offered again`
- `a pick is executable until the next tick's time and not after: the next tick decides anew, and the chunk is due again`
- `a tick that picked nothing says why, from the journal`
- `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`
- `every tick missed but the last: only the current tick is ever decided`
- `in-flight block: tick t + 1 is not decided while a pick of tick t has a transaction in flight; once it lands, it is`
- `in flight for a whole tick: that tick is missed, not decided late`
- `inside a tick, a leg in flight is not offered again; the other legs are`
- `per leg the decision price as a double and its source, and the module's perLeg, picks and next exactly as returned`
- `a null variation is stored as null (no previous price), never as 0; 'paused' is reason rule9`
- `its own feed with the feed's deviation threshold: 0.992 at band 1% is out of band with bandAdd 0.003, in band with the quorum's 0`
- `the resolver is told which leg is the stable one, and only that leg's bandAdd is used`
- `a stable leg with no price has no pair: band_add is null, the leg is out of the tick (no_price)`
- `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode`
- `order rows that show fewer executed chunks than when the tick was decided: nothing executes, on a picked leg or any other`
- `a clock that is not unix seconds (milliseconds would expire every basket), or that is behind the journal`
- `it never throws and never returns a pick, whatever it is given`
- `an error nobody foresaw is still fail closed (internal_error), never a rejection: rows and answers that throw when read`
- `the last grace tick's second slot is executable at + T / 2, before the basket expires`
- `every column the coordinator writes or reads exists: the journal row it stores, and the basket and order fields it checks`

**G2b, return before writing: a failed write is ignored and the picks are returned anyway.** 3 of 458 tests fail, 0 of them vector replays. By name:

- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `journal write failure: nothing executes and nothing is reported as written; the next poll decides`
- `it never throws and never returns a pick, whatever it is given`

**G2c, return before writing: the picks are read from the decision in memory, not from the row as stored.** 3 of 458 tests fail, 0 of them vector replays. By name:

- `the row is in the database before the call returns, and the picks are read from the row AS STORED`
- `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
- `an error nobody foresaw is still fail closed (internal_error), never a rejection: rows and answers that throw when read`

**G2d, return before writing: the write is started and not awaited: the picks are returned before the database has the row.** 7 of 458 tests fail, 0 of them vector replays. By name:

- `reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothing is bought`
- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `journal write failure: nothing executes and nothing is reported as written; the next poll decides`
- `the row is in the database before the call returns, and the picks are read from the row AS STORED`
- `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
- `an error nobody foresaw is still fail closed (internal_error), never a rejection: rows and answers that throw when read`
- `every column the coordinator writes or reads exists: the journal row it stores, and the basket and order fields it checks`

**G3a, entry from the reference row: entry = the first row with a price, the reference row included.** 280 of 458 tests fail, 252 of them vector replays. By name:

- `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys first`
- `reference row: a leg with no price at first sight has no reference, and gets its last at its first tick with a price`
- `'reference': the coordinator decides tick t in [tick time, next tick time) and nothing a second earlier`
- `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown…`
- `entry is the first TICK row's price, never the reference row's: 30% under the reference at the first tick is not protected`
- `the basket's basis points reach the module as bps ÷ 10 000, the double of the decimal: a price exactly on entry × (1 − 0.57) is protected`
- `the band reaches the module as bps ÷ 10 000 too: a sum one step above 6% is out of a 6% band`
- `the journal rows may come back in any order: the state is the same`
- `done comes from the order rows, never from the picks: a pick that did not execute is due again by the calendar`
- `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed`
- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `journal write failure: nothing executes and nothing is reported as written; the next poll decides`
- `the row is in the database before the call returns, and the picks are read from the row AS STORED`
- `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
- `an executed pick is not offered again`
- `a pick is executable until the next tick's time and not after: the next tick decides anew, and the chunk is due again`
- `a tick that picked nothing says why, from the journal`
- `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`
- `in-flight block: tick t + 1 is not decided while a pick of tick t has a transaction in flight; once it lands, it is`
- `in flight for a whole tick: that tick is missed, not decided late`
- `inside a tick, a leg in flight is not offered again; the other legs are`
- `per leg the decision price as a double and its source, and the module's perLeg, picks and next exactly as returned`
- `its own feed with the feed's deviation threshold: 0.992 at band 1% is out of band with bandAdd 0.003, in band with the quorum's 0`
- `the resolver is told which leg is the stable one, and only that leg's bandAdd is used`
- `a stable leg with no price has no pair: band_add is null, the leg is out of the tick (no_price)`
- `decideTick throwing: nothing is written and nothing executes; the next poll may decide`
- `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode`
- `every column the coordinator writes or reads exists: the journal row it stores, and the basket and order fields it checks`

**G3b, entry from the reference row: the same, but only from tick 1 on (tick 0 still passes the module's own check).** 250 of 458 tests fail, 246 of them vector replays. By name:

- `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown…`
- `entry is the first TICK row's price, never the reference row's: 30% under the reference at the first tick is not protected`
- `the journal rows may come back in any order: the state is the same`
- `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`

**G4a, a late decision: a previous tick with no row is decided now, late.** 103 of 458 tests fail, 93 of them vector replays. By name:

- `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown…`
- `restart between the row write and the execution: the stored picks come back, nothing is decided again`
- `slot 1 from the tick time; slot 2 before its time is not executable, at its time it is`
- `a leg's second slot is never offered while its first has not executed, whatever the time`
- `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`
- `every tick missed but the last: only the current tick is ever decided`
- `in flight for a whole tick: that tick is missed, not decided late`
- `order rows that show fewer executed chunks than when the tick was decided: nothing executes, on a picked leg or any other`
- `expired after the last grace tick's window, one T after its time: a second earlier the last grace tick still executes`
- `the last grace tick's second slot is executable at + T / 2, before the basket expires`

**G4b, a late decision: every missed tick is decided before the current one (back-fill).** 98 of 458 tests fail, 93 of them vector replays. By name:

- `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown…`
- `restart between the row write and the execution: the stored picks come back, nothing is decided again`
- `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`
- `every tick missed but the last: only the current tick is ever decided`
- `in flight for a whole tick: that tick is missed, not decided late`

**G4c, a late decision: the previous tick's row stands in for a current tick that has none (an old decision executes late).** 415 of 458 tests fail, 385 of them vector replays. By name:

- `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys first`
- `reference row: a leg with no price at first sight has no reference, and gets its last at its first tick with a price`
- `'reference': the coordinator decides tick t in [tick time, next tick time) and nothing a second earlier`
- `'now': the coordinator decides tick t in [tick time, next tick time) and nothing a second earlier`
- `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = the previous tick's stored next-cooldown…`
- `entry is the first TICK row's price, never the reference row's: 30% under the reference at the first tick is not protected`
- `the basket's basis points reach the module as bps ÷ 10 000, the double of the decimal: a price exactly on entry × (1 − 0.57) is protected`
- `the band reaches the module as bps ÷ 10 000 too: a sum one step above 6% is out of a 6% band`
- `the journal rows may come back in any order: the state is the same`
- `done comes from the order rows, never from the picks: a pick that did not execute is due again by the calendar`
- `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed`
- `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`
- `journal write failure: nothing executes and nothing is reported as written; the next poll decides`
- `the row is in the database before the call returns, and the picks are read from the row AS STORED`
- `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
- `an executed pick is not offered again`
- `a pick is executable until the next tick's time and not after: the next tick decides anew, and the chunk is due again`
- `a tick that picked nothing says why, from the journal`
- `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`
- `in-flight block: tick t + 1 is not decided while a pick of tick t has a transaction in flight; once it lands, it is`
- `in flight for a whole tick: that tick is missed, not decided late`
- `inside a tick, a leg in flight is not offered again; the other legs are`
- `per leg the decision price as a double and its source, and the module's perLeg, picks and next exactly as returned`
- `a null variation is stored as null (no previous price), never as 0; 'paused' is reason rule9`
- `its own feed with the feed's deviation threshold: 0.992 at band 1% is out of band with bandAdd 0.003, in band with the quorum's 0`
- `the resolver is told which leg is the stable one, and only that leg's bandAdd is used`
- `a stable leg with no price has no pair: band_add is null, the leg is out of the tick (no_price)`
- `decideTick throwing: nothing is written and nothing executes; the next poll may decide`
- `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode`
- `every column the coordinator writes or reads exists: the journal row it stores, and the basket and order fields it checks`

**G5a, execute on an unreadable basket: an unreadable basket row is used anyway.** 1 of 458 tests fail, 0 of them vector replays. By name:

- `an unreadable basket row: nothing executes, whatever is wrong with it`

**G5b, execute on an unreadable basket: the basket's status is not looked at: a cancelled basket executes.** 363 of 458 tests fail, 362 of them vector replays. By name:

- `a basket that is not active executes nothing and is not touched`

**G5c, execute on an unreadable basket: a leg order that does not match the basket is used anyway.** 1 of 458 tests fail, 0 of them vector replays. By name:

- `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket`

**G5d, execute on an unreadable basket: an unreadable journal row is used anyway.** 2 of 458 tests fail, 0 of them vector replays. By name:

- `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
- `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode`

### 4.2 All mutants

| Id | Rule | Mutant | Failing tests | Of which vector replays | A rule test that fails |
|---|---|---|---|---|---|
| G1a | decide twice | the current tick's row is ignored and the tick is decided again | 395 | 384 | `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed` |
| G1b | decide twice | the tick is decided again and the refused duplicate write is swallowed (the new decision executes) | 168 | 158 | `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed` |
| G2a | return before writing | the decision is never written; the picks come from memory | 425 | 385 | `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys…` |
| G2b | return before writing | a failed write is ignored and the picks are returned anyway | 3 | 0 | `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row` |
| G2c | return before writing | the picks are read from the decision in memory, not from the row as stored | 3 | 0 | `the row is in the database before the call returns, and the picks are read from the row AS STORED` |
| G2d | return before writing | the write is started and not awaited: the picks are returned before the database has the row | 7 | 0 | `reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothi…` |
| G3a | entry from the reference row | entry = the first row with a price, the reference row included | 280 | 252 | `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys…` |
| G3b | entry from the reference row | the same, but only from tick 1 on (tick 0 still passes the module's own check) | 250 | 246 | `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = th…` |
| G4a | a late decision | a previous tick with no row is decided now, late | 103 | 93 | `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = th…` |
| G4b | a late decision | every missed tick is decided before the current one (back-fill) | 98 | 93 | `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = th…` |
| G4c | a late decision | the previous tick's row stands in for a current tick that has none (an old decision executes late) | 415 | 385 | `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys…` |
| G5a | execute on an unreadable basket | an unreadable basket row is used anyway | 1 | 0 | `an unreadable basket row: nothing executes, whatever is wrong with it` |
| G5b | execute on an unreadable basket | the basket's status is not looked at: a cancelled basket executes | 363 | 362 | `a basket that is not active executes nothing and is not touched` |
| G5c | execute on an unreadable basket | a leg order that does not match the basket is used anyway | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| G5d | execute on an unreadable basket | an unreadable journal row is used anyway | 2 | 0 | `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malfo…` |
| T1 | tick times | 'now' ticks at t0 + (t + 1) × T, like 'reference' | 5 | 1 | `'now' mode with leg 0 unpriced: no special case, the first chunk goes to the next leg and the journal says why` |
| T2 | tick times | 'reference' ticks at t0 + t × T, like 'now' | 314 | 288 | `reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothi…` |
| T3 | tick times | one grace tick fewer | 14 | 8 | `'reference': tick t at t0 + (t + 1) × T; 'now': at t0 + t × T; t = 0 … N + 2; the second slot at + T / 2` |
| T4 | tick times | the second slot at + T / 4 | 2 | 0 | `'reference': tick t at t0 + (t + 1) × T; 'now': at t0 + t × T; t = 0 … N + 2; the second slot at + T / 2` |
| T5 | tick times | the second slot at + T | 156 | 152 | `'reference': tick t at t0 + (t + 1) × T; 'now': at t0 + t × T; t = 0 … N + 2; the second slot at + T / 2` |
| F1 | reference row | the T / 2 deadline is ignored: a reference is written whenever seen before the first tick | 2 | 0 | `reference deadline: written at t0, one second before t0 + T / 2 and a moment before t0; never at t0 + T / 2 or …` |
| F2 | reference row | the deadline is t0 + T | 3 | 0 | `reference deadline: written at t0, one second before t0 + T / 2 and a moment before t0; never at t0 + T / 2 or …` |
| F3 | reference row | exactly t0 + T / 2 still writes (>, not >=) | 2 | 0 | `reference deadline: written at t0, one second before t0 + T / 2 and a moment before t0; never at t0 + T / 2 or …` |
| F4 | reference row | the reference is written again at every sight | 2 | 0 | `reference row: it is written once; a later sight reads it and resolves no price` |
| F5 | reference row | 'now' mode records a reference too | 3 | 1 | `'reference': tick t at t0 + (t + 1) × T; 'now': at t0 + t × T; t = 0 … N + 2; the second slot at + T / 2` |
| F6 | reference row | the reference row carries a decision | 329 | 288 | `reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothi…` |
| S1 | state from rows | last ignores the reference row | 260 | 252 | `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys…` |
| S2 | state from rows | last = the FIRST row with a price | 379 | 376 | `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = th…` |
| S3 | state from rows | the cooldown is carried over a missed tick (the latest row's, not the previous tick's) | 32 | 31 | `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and e…` |
| S4 | state from rows | no cooldown at all | 249 | 246 | `done comes from the order rows, never from the picks: a pick that did not execute is due again by the calendar` |
| S5 | state from rows | done is counted from the journal's picks, not read from the order rows | 91 | 87 | `done comes from the order rows, never from the picks: a pick that did not execute is due again by the calendar` |
| S6 | state from rows | the order rows are placed by position, not by the basket's order hash | 438 | 385 | `reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothi…` |
| S7 | state from rows | threshold = bps × 0.0001 (not the double of the decimal) | 1 | 0 | `the basket's basis points reach the module as bps ÷ 10 000, the double of the decimal: a price exactly on entry…` |
| S8 | state from rows | band = bps × 0.0001 | 1 | 0 | `the band reaches the module as bps ÷ 10 000 too: a sum one step above 6% is out of a 6% band` |
| L1 | slot timing | the second slot is offered before its time | 153 | 152 | `slot 1 from the tick time; slot 2 before its time is not executable, at its time it is` |
| L2 | slot timing | an executed pick is offered again | 388 | 384 | `restart between the row write and the execution: the stored picks come back, nothing is decided again` |
| L3 | slot timing | both slots of a leg are offered at once | 1 | 0 | `a leg's second slot is never offered while its first has not executed, whatever the time` |
| L4 | slot timing | an order row with fewer executed chunks than at the decision is accepted | 1 | 0 | `order rows that show fewer executed chunks than when the tick was decided: nothing executes, on a picked leg or…` |
| I1 | in flight | a new tick is decided while a transaction is in flight | 3 | 0 | `in-flight block: tick t + 1 is not decided while a pick of tick t has a transaction in flight; once it lands, i…` |
| I2 | in flight | a leg in flight is offered again | 1 | 0 | `inside a tick, a leg in flight is not offered again; the other legs are` |
| I3 | in flight | a locked order row ('executing') does not count as in flight | 1 | 0 | `an order row that is locked ('executing') counts as in flight, with or without the caller's list` |
| I4 | in flight | a missing in-flight list is read as empty | 1 | 0 | `the in-flight list is required and must name legs of this basket: otherwise nothing executes` |
| I5 | in flight | expiry does not wait for a transaction in flight | 1 | 0 | `expiry waits for a transaction in flight: its outcome may complete the basket` |
| J1 | journal | a decision price is rounded to 8 decimals before it is stored | 22 | 20 | `per leg the decision price as a double and its source, and the module's perLeg, picks and next exactly as retur…` |
| J2 | journal | a null variation is stored as 0 | 262 | 257 | `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys…` |
| J3 | journal | the source label is not checked (a URL can reach the journal) | 1 | 0 | `a price resolver that throws, or answers with anything but a price or null: nothing is decided, and its message…` |
| J4 | journal | two rows for one tick are accepted | 1 | 0 | `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode` |
| J5 | journal | a journal ahead of the clock is accepted | 1 | 0 | `a clock that is not unix seconds (milliseconds would expire every basket), or that is behind the journal` |
| J6 | journal | the row the insert answers with may be another tick's | 1 | 0 | `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malfo…` |
| J7 | journal | an error's message goes into the detail | 6 | 0 | `journal write failure: nothing executes and nothing is reported as written; the next poll decides` |
| P1 | stable pair | the stable leg's bandAdd is dropped (always 0) | 11 | 9 | `the band reaches the module as bps ÷ 10 000 too: a sum one step above 6% is out of a 6% band` |
| P2 | stable pair | a stable price without its bandAdd is taken with 0 | 1 | 0 | `a stable price without its bandAdd is no pair: nothing is decided and nothing is written` |
| P3 | stable pair | any leg's bandAdd is taken as the stable leg's | 1 | 0 | `a stable price without its bandAdd is no pair: nothing is decided and nothing is written` |
| C1 | fail closed | leg token not matched (row) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C2 | fail closed | leg token not matched (signed order) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C3 | fail closed | n not matched (row) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C4 | fail closed | n not matched (signed order) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C5 | fail closed | owner not matched (row) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C6 | fail closed | owner not matched (signed order) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C7 | fail closed | chain not matched | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C8 | fail closed | token sold not matched (row) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C9 | fail closed | token sold not matched (signed order) | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C10 | fail closed | basket_id of the order row not matched | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C11 | fail closed | a selection-module error becomes an empty decision that is written | 1 | 0 | `decideTick throwing: nothing is written and nothing executes; the next poll may decide` |
| C12 | fail closed | a resolver that throws is read as 'no price' on every leg | 2 | 0 | `a price resolver that throws, or answers with anything but a price or null: nothing is decided, and its message…` |
| C13 | fail closed | a clock in milliseconds is accepted | 1 | 0 | `a clock that is not unix seconds (milliseconds would expire every basket), or that is behind the journal` |
| C14 | fail closed | a failed journal read is read as an empty journal | 2 | 0 | `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode` |
| C15 | fail closed | an unexpected error is rethrown instead of failing closed | 1 | 0 | `an error nobody foresaw is still fail closed (internal_error), never a rejection: rows and answers that throw w…` |
| U1 | status | expired at the last grace tick's time, not at the end of its window | 26 | 20 | `'reference': tick t at t0 + (t + 1) × T; 'now': at t0 + t × T; t = 0 … N + 2; the second slot at + T / 2` |
| U2 | status | completed is never written | 366 | 362 | `completed when every leg is complete: the status is written, and nothing is read, resolved or decided` |
| U3 | status | completed as soon as one leg is complete | 388 | 382 | `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = th…` |
| U4 | status | expired is never written | 24 | 22 | `expired after the last grace tick's window, one T after its time: a second earlier the last grace tick still ex…` |
| U5 | status | an unconfirmed status write counts as written | 1 | 0 | `a status write that fails or is not confirmed is reported, and tried again at the next poll` |
| U6 | status | expired takes precedence over completed | 2 | 0 | `a basket that finished is completed even when it is looked at after its end; an unfinished one expires` |
| U7 | status | expired one second late (>, not >=) | 23 | 22 | `expired after the last grace tick's window, one T after its time: a second earlier the last grace tick still ex…` |
| S9 | state from rows | the journal rows are taken in the order the database returned them | 379 | 376 | `last = the latest row with a price (reference included), entry = the first TICK row with a price, cooldown = th…` |
| L5 | slot timing | a slot counts as executed one chunk late (<, not <=) | 388 | 384 | `restart between the row write and the execution: the stored picks come back, nothing is decided again` |
| I6 | in flight | an in-flight entry that names no leg of the basket is let through | 1 | 0 | `the in-flight list is required and must name legs of this basket: otherwise nothing executes` |
| J8 | journal | decided_at is written from seconds as if they were milliseconds | 4 | 0 | `reference row: at first sight before t0 + T / 2 the three prices are written as tick -1, prices only, and nothi…` |
| J9 | journal | band_add is stored as 0 when the stable leg had no price | 1 | 0 | `a stable leg with no price has no pair: band_add is null, the leg is out of the tick (no_price)` |
| J10 | journal | a pick names another leg's order | 395 | 384 | `reference seen too late: no reference row is ever written and the first tick runs with last null, so leg 0 buys…` |
| C16 | fail closed | an executed count above n is let through to the module | 1 | 0 | `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket` |
| C17 | fail closed | failClosed is never set | 16 | 0 | `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row` |

## 5 Verify: the EVIDENCE block as printed

`scripts/agent-verify.sh --keeper --codeql`, run with the two feedback files as the only uncommitted changes (their
line counts in the `diff --stat` below are therefore those of the last commit, not of the final files):

```
=== EVIDENCE ===
branch: feat/split-dca-coordinator @ 6ecbe7cf (base origin/main @ 4a4129ef)
suite:       PASS 10845 tests passed, 0 failed, 507 files
lint-delta:  PASS errors +0, warnings +0 (2 changed files; head 0 err/0 warn, base 0 err/0 warn)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      PASS node20:2021-pass/0-fail/0-cancelled node22:2021-pass/0-fail/0-cancelled
diff --stat origin/main...HEAD:
 contracts/order-engine/executor/basket-coordinator.js       |  678 ++++++++++++
 contracts/order-engine/executor/basket-coordinator.test.mjs | 1748 +++++++++++++++++++++++++++++++
 contracts/order-engine/schema.sql                           |  238 +++++
 docs/feedback/feat-split-dca-coordinator.evidence.md        |  156 +++
 docs/feedback/feat-split-dca-coordinator.md                 |   90 ++
 supabase/migrations/20261116120000_baskets_split_dca.sql    |  289 +++++
 6 files changed, 3199 insertions(+)
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/split-dca-coordinator
RESULT: PASS
=== END EVIDENCE ===
```

After it, on the same tree: `node scripts/gen-claude-state.mjs --check` → "CLAUDE.md state block is current";
`node scripts/check-agents-parity.mjs` → "AGENTS.md parity OK"; `gitleaks detect --log-opts="origin/main..HEAD"` →
"no leaks found".
