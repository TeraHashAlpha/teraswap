# Runbook — DCA freeze (circuit breaker)

**Scope:** how to **FREEZE** and **UNFREEZE** TeraSwap **DCA-order execution** during an incident, and the
**nuclear escalation** (on-chain `pause()`) for a *confirmed* key/wallet compromise.

**Audience:** the owner / on-call operator holding the `DCA_FREEZE_SECRET` Bearer token (app-layer freeze)
and the OrderExecutor **admin** key (on-chain pause). The 0x9A38… admin wallet is the **client UI** gate;
the **server** enforces the Bearer secret, exactly like `/api/admin/kill-switch`.

> ⚠️ **The freeze is a DELAY, never a loss.** Freezing does **not** cancel any order, does **not** move or
> touch any user funds, and does **not** change any approval. Users can still cancel their own orders
> while frozen. Pending DCAs **resume automatically on unfreeze** — the OrderExecutor tracks cumulative
> progress on-chain, so no chunk is skipped or double-spent.

---

## 0. What the freeze actually does

| Layer | Mechanism | Effect when frozen |
|---|---|---|
| App API (`/api/orders` create) | reads `circuit_breaker` via `getDcaFreezeState()` | new DCA orders are refused at creation while frozen |
| Keeper (`executor.js`) | reads `circuit_breaker?id=eq.dca` each cycle | **skips** `order_type='dca'` execution; `limit` / `stop_loss` still execute |
| Storage | Supabase table `circuit_breaker`, single row `id='dca'` | `frozen=true` is the switch |

**Fail-open by design.** If the table is missing, the row is missing, or the read errors, **both** the API
and the keeper treat the system as **NOT frozen**. The breaker can only *stop* execution when it is
explicitly set and readable. The on-chain `pause()` (§4) is the real fail-safe.

**What freeze does NOT do:** no order cancellation, no fund movement, no approval/allowance change, no
contract state change. It is purely a "don't start new DCA chunks this cycle" gate.

---

## 1. Apply the SQL (one-time)

The table may not exist in prod yet. Apply the DDL once:

1. Open the **Supabase SQL Editor** for the production project.
2. Paste the contents of [`supabase/circuit-breaker.sql`](../../supabase/circuit-breaker.sql) and **Run**.
3. The script is **idempotent** — `CREATE TABLE IF NOT EXISTS`, an `ON CONFLICT DO NOTHING` seed row, and
   guarded RLS policies. Re-running it never clobbers a live freeze.

Verify the seed row exists and is unfrozen:

```sql
SELECT id, frozen, reason, updated_at, updated_by FROM circuit_breaker WHERE id = 'dca';
-- expect: dca | f | (null) | <ts> | seed
```

> The keeper and API both **fail open** until the table exists, so applying the SQL is what *enables* the
> freeze capability — it does not change behaviour on its own (row seeds as `frozen=false`).

---

## 2. FREEZE (app layer)

Freezing is a single authenticated POST to the admin route. The server enforces the Bearer secret; the
0x9A38… wallet is only the **client UI** gate.

```bash
curl -sS -X POST https://www.teraswap.app/api/admin/dca-freeze \
  -H "Authorization: Bearer $DCA_FREEZE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"frozen": true, "reason": "INC-YYYY-MM-DD-NNN: <short reason>"}'
```

- `reason` is recorded in `circuit_breaker.reason` for the audit trail — reference the incident id.
- The secret lives **server-side only** (env / KMS). Never paste it into a doc, ticket, or chat.
- Effect is near-immediate: the **next keeper cycle** skips DCA execution and new DCA orders are refused.

Confirm:

```sql
SELECT frozen, reason, updated_at, updated_by FROM circuit_breaker WHERE id = 'dca';
-- expect: t | INC-... | <ts> | <operator>
```

---

## 3. UNFREEZE (app layer)

When the incident is resolved, lift the freeze:

```bash
curl -sS -X POST https://www.teraswap.app/api/admin/dca-freeze \
  -H "Authorization: Bearer $DCA_FREEZE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"frozen": false, "reason": "INC-YYYY-MM-DD-NNN resolved"}'
```

**Resume semantics:** pending DCA orders simply continue on the next keeper cycle. The OrderExecutor
computes each chunk against **cumulative** on-chain progress
(`cumulativeTarget = amountIn * (execCount + 1) / dcaTotal` minus what was already executed), so a freeze
window never skips, duplicates, or double-charges a chunk. Schedules slip by the freeze duration only.

---

## 4. NUCLEAR escalation — on-chain `pause()` / `unpause()`

Use this **only** for a *confirmed* key/wallet/keeper compromise (e.g. the executor key is suspected
stolen) — when stopping the app-layer freeze is not enough because an attacker could execute orders
directly against the contract. This is the real fail-safe; the app freeze is a soft gate.

`pause()` / `unpause()` are **admin-only** on `TeraSwapOrderExecutor` and halt **all** on-chain order
execution (DCA, limit, and stop-loss alike) — it is broader and blunter than the DCA freeze.

```bash
# PAUSE — admin key only. Halts ALL order execution on-chain.
cast send <ORDER_EXECUTOR_ADDRESS> "pause()" \
  --rpc-url "$MAINNET_RPC_URL" --account <admin-keystore>

# UNPAUSE — after the compromise is contained and keys are rotated.
cast send <ORDER_EXECUTOR_ADDRESS> "unpause()" \
  --rpc-url "$MAINNET_RPC_URL" --account <admin-keystore>
```

- `<ORDER_EXECUTOR_ADDRESS>` = the deployed `TeraSwapOrderExecutor` (`NEXT_PUBLIC_ORDER_EXECUTOR_ADDRESS`).
- The admin signer is the OrderExecutor `admin`; a non-admin call reverts `NotAdmin()`.
- After a confirmed compromise, follow the key-rotation steps in
  [`executor-compromise.md`](executor-compromise.md) **before** unpausing.
- Even `pause()` does **not** cancel orders or move funds — it only stops execution. User cancellations and
  withdrawals remain available.

---

## 5. Decision guide

| Situation | Action |
|---|---|
| Suspicious DCA activity, keys believed safe | **App freeze** (§2). Investigate. Unfreeze (§3) when clear. |
| Keeper misbehaving / bad config, keys safe | **App freeze** (§2) while you fix the keeper. |
| Confirmed key / wallet / keeper compromise | **On-chain `pause()`** (§4) immediately, then rotate keys per `executor-compromise.md`. |

---

## 6. Invariants (do not violate)

- **No auto-freeze.** The monitoring bot **never** sets the flag; freezing is always a human decision.
- **Fail-open reads.** Missing table / missing row / read error ⇒ NOT frozen, on both API and keeper.
- **No secrets in this repo.** `DCA_FREEZE_SECRET` and admin keys live in env / KMS only.
- **Freeze = delay, never loss.** No cancel, no fund movement, no approval change at any layer.
