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
