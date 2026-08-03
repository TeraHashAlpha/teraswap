# DCA-VISIBILITY-DATA — investigation report (READ-ONLY)

> **Prompt:** `docs/Prompts/INVESTIGATE-DCA-VISIBILITY-DATA.md` · **Date:** 2026-07-07 · **Base:** `origin/main` @ 5aa62a1
> **Question:** are product asks #2 (DCA fills in History) and #3 (completed DCA positions with stats incl. P&L vs spot)
> **frontend-only**, or does the keeper's execution recording need enriching first?
> **Verdict: FRONTEND-ONLY.** Every asked stat is computable from existing `orders` + `order_executions` columns plus the
> existing #18/#248 price plumbing. Zero keeper/schema changes required (two strictly-optional keeper nice-to-haves listed §8).

---

## 1. Schema — live-verified

Sources: `contracts/order-engine/schema.sql` (authoritative DDL) cross-checked against the **live** production DB via the
existing service-role API routes (`/api/orders?status=executed,…` and `/api/orders/:id/executions` both `select('*')`, so
their JSON keys are the live column list; no key material touched — see §9 method note).

### `orders` (35 live columns — matches schema.sql exactly)

Identity/params: `id`, `wallet`, `order_hash` (unique), `order_type` (`limit|stop_loss|dca`), `token_in`, `token_out`,
`token_in_symbol`, `token_out_symbol`, `token_in_decimals`, `token_out_decimals`, `amount_in` (TOTAL to sell, raw wei text),
`min_amount_out`, `target_price`, `price_feed`, `price_condition`, `current_price`, `expiry`, `nonce`, `signature`,
`order_data` (full EIP-712 struct JSONB), `router` (pinned), `chain_id`, `created_at`, `updated_at`.

DCA scheduling: `dca_interval` (sec), `dca_total` (planned fills M), `dca_executed` (done N, keeper-PATCHed),
`dca_last_exec` (timestamptz).

Execution summary: `tx_hash` (last fill), `amount_out`, `fee_amount`, `gas_used`, `executed_at`, `executed_price`, `error`.
⚠ Live reality: **`amount_out`, `executed_price`, `fee_amount`, `gas_used` are NULL even on the completed DCA** — the
keeper's order-PATCH writes only `status`/`dca_executed`/`dca_last_exec`/`tx_hash`/`executed_at`/`updated_at`
(`executor.js` ~1226-1256). Per-fill truth lives in `order_executions`; the order-level summary columns are legacy.

### `order_executions` (11 live columns — matches schema.sql exactly)

`id`, `order_id` (FK→orders, CASCADE), `created_at` (= fill confirmation time), `execution_number` (1-based),
`tx_hash` (NOT NULL; unique idx `idx_executions_tx_hash` in DDL as defense-in-depth — keeper is already idempotent
app-side), `amount_in` (ACTUAL per-fill, event-decoded), `amount_out` (ACTUAL per-fill, event-decoded), `fee_amount`
(input-token-denominated — observed exactly 0.1% of per-fill `amount_in`), `gas_used`, `price_at_execution`
(**exists but NULL on all live rows** — the executor never passes `priceAtExecution` into `buildExecutionRow`),
`status` (`confirmed|failed|pending`).

Recording path (`record-execution.js`, CHORE-KEEPER-RECORD-EXECUTIONS): per-fill amounts decoded from the on-chain
`OrderExecuted(orderHash, owner, orderType, tokenIn, tokenOut, amountIn, amountOut, fee)` event (authoritative; fallback =
`amount_in/dca_total` + `amount_out="0"` only if the event can't be decoded — no live row needed the fallback), confirmed-
receipts only, idempotent by `tx_hash`, `res.ok` checked (the old silent-400 bug is fixed and the fix is live).

### Status lifecycle (who sets what)

`status ∈ {active, executing, executed, cancelled, expired, failed}` — **there is no `completed` value; the terminal
success state is `executed`.** Transitions: create → `active` (API); keeper locks `executing` during an attempt and
unlocks back to `active`; on a confirmed fill `nextOrderStatus()` cycles DCA `active→active` until `dca_executed ≥
dca_total`, then **`executed` + `executed_at` stamped** (limit/SL: `executed` on their single fill); keeper sets
`expired` past expiry and `failed` after the retry-policy cap (#246), preserving completed chunks; user cancel PATCHes
`cancelled` (signed, W6). UI mapping (`useOrderEngine.mapDbStatus`): `executed→filled`, `failed→error`.

---

## 2. Live data reality (production, 2026-07-07)

`/api/orders/stats` (global): **35 orders — 0 active, 1 executed, 27 cancelled, 0 expired** (7 `failed` — the stats route
doesn't count that status; minor gap, noted §8). All DCA activity so far belongs to the test wallet `0xd44d…962d`
(confirmed by decoding the `OrderExecuted` log of the spec's reference tx `0x4691b42a…d7fac` on Base):

- **`5449dea0` — the one completed DCA: WETH→ETHFI on Base, 5/5 fills, `status=executed`, `executed_at` set (2026-07-05).**
  Its 5 `order_executions` rows are fully populated and real: `amount_in` exactly 0.004 WETH each; `amount_out` varies with
  the market (19.57 / 19.56 / 20.32 / 17.70 / 16.75 ETHFI); fee exactly 0.1% of input; gas_used per fill; daily cadence
  11:51–11:53 UTC 07-01→07-05 (24h interval honoured). ⇒ the keeper ran daily through 07-05 and recording works end-to-end.
- `4ed3d6de` (the specs' backfill target): 1/3, `failed` — the backfilled chunk is visible (`dca_executed=1`).
- Remainder: 6 failed / 12+ cancelled test DCAs (Base + mainnet), all 0-fill except the above.

---

## 3. Per-stat feasibility (product ask #3)

| Stat | Verdict | Compute path |
|---|---|---|
| Avg buy price / cost-basis | **Computable** | Σ`amount_in` ÷ Σ`amount_out` over `confirmed` fills — realized, event-decoded, exact (no oracle needed). Per-fill rate = `amount_in/amount_out`. |
| Total invested | **Computable** | Σ`amount_in` over fills (equals `orders.amount_in × N/M`; contract splits chunks evenly). |
| Total received | **Computable** | Σ`amount_out` over fills. (Do NOT use `orders.amount_out` — NULL, see §1.) |
| # fills executed / planned | **Computable** | `orders.dca_executed / dca_total` (keeper-authoritative) — or COUNT of confirmed fills; both agree live. |
| Date range | **Computable** | `orders.created_at → executed_at`; per-fill MIN/MAX(`created_at`). |
| Next fill (active) | **Computable — already shipped** | last fill `created_at` (or `dca_last_exec`) + `dca_interval`; live countdown already implemented (`useOrderExecutions` + `CountdownCenter`). |
| % complete | **Computable** | `dca_executed / dca_total`. |
| **P&L vs current spot** | **Computable with existing plumbing** | USD P&L = Σ`amount_out`×spot(token_out) − Σ`amount_in`×spot(token_in). Spot: **`/api/portfolio/prices`** (batch DefiLlama #248, server-side, cached+rate-limited, chain-aware) — or server-side `fetchChainlinkPriceRaw` (#18, incl. Base composed feeds) / `fetchDefiLlamaPrice`. Both plumbings confirmed reusable; nothing new to build. Token-denominated variant (ETHFI received vs ETHFI-equivalent of invested WETH at spot) uses the same two prices. |
| (bonus) per-fill USD at fill time | Needs-a-field OR derivable | `price_at_execution` exists but is NULL (executor never passes it). Realized per-fill rate is derivable from amounts (better data); HISTORICAL USD would need the keeper to start populating the column (1-line optional change) or `fetchHistoricalPrice` (Chainlink round walk, exists in `chainlink.ts`) at render/backfill time. Not required by the ask. |
| (bonus) gas cost in USD | Partial / derivable-on-chain | `gas_used` recorded; gas PRICE is not → USD gas needs `eth_getTransactionReceipt.effectiveGasPrice` (derivable on-chain) or an optional new column. Not required by the ask. |

---

## 4. Spec reconciliation (the 3 existing specs)

⚠ All three spec files exist **only on `origin/chore/rescue-prompt-specs`** (unmerged; the rescue chore is pending) — none
is on `main`, though their implementations largely are:

| Spec | State on main | Covers ask #2/#3? |
|---|---|---|
| `CHORE-KEEPER-RECORD-EXECUTIONS` | **Implemented & live** (`record-execution.js` + executor wiring + `backfill-execution.mjs` + tests + DDL idempotency index). Deliberate divergences: no per-row source/route/chainId/USD columns — derived via the `orders` join (#228 pattern); the spec's "active → completed" is `executed` in the real enum. | Enables both; specs neither History UI nor position stats. |
| `CHORE-ANALYTICS-DCA-EXECUTIONS` | **Implemented & live** (`/api/analytics` merges `swaps` + `order_executions` with embedded parent `orders`, swaps-first `tx_hash` dedup, per-chunk USD from the parent, `ROUTER_TO_SOURCE`). | Analytics only — NOT the wallet History tab (#2) nor position stats (#3). Its merge/dedup pattern is the blueprint for #2. |
| `CHORE-DCA-POSITIONS-DASHBOARD` | **Implemented for ACTIVE positions** (dca/ suite: `MissionControlCard` countdown ring, `DCAFillsTimeline`, `useOrderExecutions` polling; decimals/chain threading). Completed/failed/cancelled DCAs render only as compact history cards in the flag-gated DCA tab (`historyDCA` filter incl. `filled`). | Partially adjacent to #3: fills timeline + countdown exist; **aggregate per-position stats (cost-basis, totals, P&L) exist nowhere**. |

**Conclusion:** no existing spec covers ask #2 (History feed) or ask #3's stats block — new frontend spec(s) needed; no
contradiction with the three above (they are the data-producing stack the new UI reads).

---

## 5. `Completed (0)` root cause

The pipeline is **correct end-to-end** — verified at every hop:
keeper sets `executed` on the final chunk (`nextOrderStatus`, live-evidenced by `5449dea0`) → `/api/orders` with no/terminal
status filter returns it (live-verified through the production API) → `mapDbStatus('executed') → 'filled'` →
`OrderDashboard` Completed tab filters `status === 'filled'` (`OrderDashboard.tsx:49`).

So Completed(0) is **data reality, not a filter bug**: the entire database holds exactly **one** ever-completed order —
the Base test DCA `5449dea0` owned by `0xd44d…962d` (completed 2026-07-05). Any other connected wallet truthfully sees 0.
Two compounding visibility caveats:
1. **Read-auth gate (W6-M-01):** the Orders tab's initial fetch has no status filter → requires the once-per-session wallet
   read signature; if the user declines it, **all three tabs show 0** (not just Completed). A terminal-only fetch for the
   Completed/Cancelled tabs would be public and auth-free — a UX option, not a bug.
2. The completed position also renders in the **DCA tab → Positions history** — but that tab is launch-flag-gated
   (`NEXT_PUBLIC_DCA_ENABLED`, Base) and shows a compact card with no stats.

**Repro guidance for the owner:** connect `0xd44d…962d`, open Orders, accept the read signature → Completed (1) with the
WETH→ETHFI 5/5 order is expected today.

---

## 6. History source (product ask #2)

Two separate surfaces exist:
- **History tab** = `WalletHistory` → `GET /api/history?wallet=` → **Supabase `swaps` table only** (client-logged instant
  swaps via `/api/log-swap`). DCA fills live in `order_executions` → **structurally invisible here**. This is the ask's
  surface.
- Instant tab's `SwapHistory` = an **in-memory zustand session list** (comment claims "localStorage no MVP" but there is no
  persist middleware — records vanish on reload). Not the ask's surface; drift noted §8.

**How to surface DCA fills — recommendation:** extend `/api/history` server-side to UNION `order_executions ⋈ orders`
(filter `orders.wallet = :wallet`, `status='confirmed'`) with the `swaps` query — the **same merge + swaps-first `tx_hash`
dedup already proven in `/api/analytics`** — emitting a `kind: 'swap' | 'order_fill'` (+ `order_type`) discriminator that
`WalletHistory` renders as a "DCA" badge/filter chip. Service-role route ⇒ no RLS/JWT issue; wallet-scoping via the join;
no schema change. Field mapping note: `swaps.amount_out` is the EXPECTED output while `order_executions.amount_out` is the
ACTUAL received — the merged feed should label accordingly (fills are the higher-fidelity rows). A client-side second-fetch
merge would also work but duplicates the dedup logic; the server union is the cleaner, precedented path.

---

## 7. Recommendation

**FRONTEND-ONLY. The keeper recording does NOT need enrichment for either ask.**

- **Ask #2 (History):** one read-only API-route extension (`/api/history` union, §6) + `WalletHistory` badge/filter. No
  keeper, no schema change.
- **Ask #3 (Completed positions + stats):** enrich the Completed surface (Orders tab and/or DCA history cards) with an
  aggregate stats block computed from the existing `GET /api/orders/:id/executions` payload (one fetch per expanded
  position — meta + all fills already bundled) + spot prices from `/api/portfolio/prices`. All eight asked stats are
  green-lit in §3. Optionally later: a tiny `GET /api/orders/:id/stats` server aggregate if client math is unwanted.

**Optional keeper nice-to-haves (explicitly NOT required, non-blocking):**
1. Pass the Chainlink price into `buildExecutionRow`'s existing `priceAtExecution` param (column already exists, 1-line) —
   only buys historical "USD at fill time"; realized rate already derivable.
2. Record `effectiveGasPrice` per fill — only needed for net-P&L-including-gas.

---

## 8. Adjacent findings (no changes made — for backlog triage)

1. **Local `.env.local` Supabase keys are dead** (2-segment ~145-char stubs; the project has rotated/migrated keys — live
   API returns `Invalid API key` for both anon + service-role). Local scripts/dev against Supabase silently broken; prod
   (Vercel env) unaffected. Also its first var name reads `EXT_PUBLIC_ORDER_EXECUTOR_ADDRESS` (leading `N` missing) — that
   var is dead locally too. Re-pull env (`vercel env pull`) when local DB access is next needed.
2. `fetchDCAExecutions` (`src/lib/order-engine/supabase.ts`) is dead code: no component calls it, and its anon-key + RLS
   path would return empty anyway (the app has no Supabase-Auth JWT carrying `wallet_address`). Candidate for removal.
3. `/api/orders/stats` omits the `failed` status from its counts (35 total vs 28 across returned buckets today).
4. `useSwapHistory` store comment claims localStorage persistence; the store is memory-only (no `persist`) — records lost
   on reload. Either persist or fix the comment when touching #2.
5. `orders`-level summary columns (`amount_out`, `executed_price`, `fee_amount`, `gas_used`) are never written by the
   current keeper — any UI reading them shows nulls; per-fill rows are the source of truth (the `[id]/executions` route's
   synthetic-legacy fallback already handles this).
6. My prior session memory said "executor should NOT be running" — stale: live fills 07-01→07-05 prove the keeper runs
   daily. (Memory updated.)

## 9. Method note (secret hygiene)

The live schema/data reads used **only the existing production API routes** (which hold the service role server-side):
`/api/orders/stats`, `/api/orders?wallet&status=<terminal>` (terminal statuses are public-by-design per W6),
`/api/orders/:id/executions?wallet`, `/api/analytics` — plus one public Base RPC `eth_getTransactionReceipt` to attribute
the reference tx. The stale local service-role key was never printed, transmitted anywhere except Supabase's own endpoint,
or committed; diagnostics were structural only (segment count/length). Zero writes anywhere.
