# Sprint 14 — 13A Audit Fixes + Payment Flows (Recipient Field)

**Sprint window:** Post-Sprint 13A APPROVED → TBD
**Sprint goal:** Fix 2 LOWs from Sprint 13A audit, then add `recipient` parameter to v1/quote and v1/swap enabling payment flows. ROADMAP Phase 2.1 extension.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 13A APPROVED (0C/0H/0M/2L/2I, 2026-05-13). 550 tests passing.
**References:**
- Sprint 13A audit report: `Audits/Sprint/audit-sprint-13a.md` (13A-L-01, 13A-L-02)
- Uniswap API payment flows announcement (May 12, 2026): https://x.com/UniswapBuilders/status/2054209584374386936
- Existing v1/quote: `src/app/api/v1/quote/route.ts`
- Existing v1/swap: `src/app/api/v1/swap/route.ts`
- Adapter types: `src/lib/adapters/types.ts` (SwapParams interface)
- Adapter dispatch: `src/lib/api.ts` (fetchSwapFromSource)
- Recipient validation: `src/app/api/swap/route.ts` (validateCallDataRecipient)

---

## Architecture Context

**Why this matters:** A `recipient` field transforms TeraSwap from a swap tool into a payment rail. Integrators can build checkouts ("pay in USDC, merchant receives ETH"), payouts ("send WBTC, recipient receives USDC"), and cross-asset transfers — all in one API call. Uniswap just launched this on May 12, 2026. We can offer the same with better pricing from 11 sources.

**What exists:** All adapters already support recipient/receiver natively but hardcode it to `from`:
- CoW: `receiver` field (already nullable, defaults to `from`)
- Uniswap V3: `recipient` in exactInputSingle
- Balancer: `receiver` in swap request
- KyberSwap: `recipient` in route/build
- Curve: `_receiver` in exchange ABI
- Velora: `receiver` in transaction body

**What's needed:** Thread `recipient` through `SwapParams` → `fetchSwapFromSource` → each adapter. Update v1/quote and v1/swap to accept and validate the field. Relax the `validateCallDataRecipient` check to allow explicit recipients on v1 (not on the frontend endpoint).

**Security constraint:** The `recipient` must be a valid Ethereum address. The `sender` (who signs the tx) is always the payer. FeeCollector V2 still collects the protocol fee from the input amount before the swap — the fee model is unchanged.

---

## RICE Prioritisation

| # | Prompt | R | I | C | E | RICE | Priority |
|---|--------|---|---|---|---|------|----------|
| 103 | 13A-FIX-01: Supabase RPC for gasless stats | 8 | 2 | 0.9 | 0.25 | 57.6 | P0 (audit) |
| 104 | 13A-FIX-02: Server-side gas_savings_usd | 8 | 2 | 0.9 | 0.25 | 57.6 | P0 (audit) |
| 101 | SwapParams recipient + adapter threading | 8 | 3 | 0.9 | 0.5 | 43.2 | P1 |
| 102 | v1/quote + v1/swap recipient field | 8 | 3 | 0.9 | 0.5 | 43.2 | P1 |

**Execution order:** P103 → P104 → P101 → P102

**Dependency graph:**
```
P103 (audit fix, independent)
P104 (audit fix, independent)
P101 ──→ P102 (API layer depends on adapter support)
```

---

## Sprint status table

| # | Prompt | Description | ROADMAP | Status |
|---|--------|------------|---------|--------|
| 103 | Supabase RPC gasless stats | Replace O(N) JS reduce with SQL aggregate | 2.2 fix | Pending |
| 104 | Server-side gas_savings_usd | Derive gas savings server-side, cap $500 | 2.2 fix | Pending |
| 101 | SwapParams recipient threading | Thread recipient through adapters | 2.1 | Pending |
| 102 | v1/quote + v1/swap recipient | Expose recipient in Public API | 2.1 | Pending |

---

## Prompt 103 — Supabase RPC for gasless stats [13A-L-01 fix]

**Status:** Pending

**Context:** Sprint 13A audit finding 13A-L-01: `/api/stats` fetches all gasless rows to Node to compute `totalGasSavedUsd` via `.reduce()`. This is O(N) memory and network. The COUNT query already uses `head: true` correctly, but the SUM does not.

**Objective:** Replace the client-side SUM with a Supabase RPC call that runs `SUM(gas_savings_usd)` server-side.

**Requirements:**

1. **Create Supabase migration** `supabase/migrations/20260514_gasless_stats_rpc.sql`:
   ```sql
   CREATE OR REPLACE FUNCTION gasless_stats()
   RETURNS TABLE(total_gasless bigint, total_gas_saved numeric) AS $$
     SELECT
       COUNT(*),
       COALESCE(SUM(gas_savings_usd), 0)
     FROM swaps
     WHERE is_gasless = true
       AND (status = 'confirmed' OR (status = 'pending' AND tx_hash IS NOT NULL))
   $$ LANGUAGE sql STABLE;
   ```

2. **Update `src/app/api/stats/route.ts`:**
   - Replace the `.select('gas_savings_usd')` fetch + `.reduce()` loop with a single `.rpc('gasless_stats')` call
   - Remove the `gaslessSumRows` variable
   - Keep the response shape unchanged: `totalGaslessSwaps`, `totalGasSavedUsd`, `gaslessRatio`, `avgGasSavingsPerSwap`

**Do NOT**

- Change the response shape of `/api/stats`
- Remove the `idx_swaps_is_gasless` index
- Modify any other endpoint

**Files affected**

- `supabase/migrations/20260514_gasless_stats_rpc.sql` (new)
- `src/app/api/stats/route.ts`

**Expected output**

- 1 atomic commit
- `/api/stats` gasless block computed via single Supabase RPC call
- Zero rows transferred to Node for aggregation

**Quality criteria**

- `npx tsc --noEmit` clean
- All tests passing
- Response shape identical to before (backwards compatible)

---

## Prompt 104 — Server-side gas_savings_usd derivation [13A-L-02 fix]

**Status:** Pending

**Context:** Sprint 13A audit finding 13A-L-02: `gas_savings_usd` is client-provided and clamped to [0, 10000]. A malicious CoW swap client could send `gasSavingsUsd: 9999` on every swap, inflating aggregate dashboard totals.

**Objective:** Derive `gas_savings_usd` server-side using the adapter's gas estimate, removing trust in the client value.

**Requirements:**

1. **Update `src/app/api/log-swap/route.ts`:**
   - When `source === 'cowswap'`:
     - Accept optional field `bestNonCowGasUsd` from client (advisory, for logging)
     - Derive `gas_savings_usd` as `Math.max(0, Math.min(Number(bestNonCowGasUsd ?? 0), 500))` — cap at $500 (no single Ethereum swap saves >$500 in gas)
   - When source is not cowswap: `gas_savings_usd = 0` (unchanged)

2. **Update `src/hooks/useSwap.ts`:**
   - Rename the field sent to log-swap from `gasSavingsUsd` to `bestNonCowGasUsd`
   - Pass the raw adapter gasUsd value from the best non-CoW quote (not the recommendation engine's computed value)

3. **Tighten the clamp** from [0, 10000] to [0, 500].

4. **Add test:**
   - In log-swap tests: verify that `bestNonCowGasUsd: 9999` gets clamped to 500
   - Verify `bestNonCowGasUsd: -5` gets clamped to 0

**Do NOT**

- Remove the clamp entirely
- Change `is_gasless` derivation (already server-authoritative)
- Change the migration schema (column type unchanged)

**Files affected**

- `src/app/api/log-swap/route.ts`
- `src/hooks/useSwap.ts`
- Test file for log-swap

**Expected output**

- 1 atomic commit
- `gas_savings_usd` derived server-side with $500 cap
- Client can no longer inflate aggregate savings

**Quality criteria**

- `npx tsc --noEmit` clean
- All tests passing
- Backwards compatible (field renamed but old clients sending `gasSavingsUsd` should still work or be ignored gracefully)

---

## Prompt 101 — SwapParams recipient + adapter threading [Phase 2.1]

**Status:** Pending

**Context:** All swap adapters already support a recipient/receiver address but hardcode it to `from` (the sender). We need to thread an optional `recipient` through the swap pipeline so that when present, the output goes to a different address than the sender.

**Objective:** Add `recipient` to `SwapParams` and update all adapters to pass it through.

**Requirements:**

1. **Update `src/lib/adapters/types.ts`** — add `recipient` to `SwapParams`:
   ```typescript
   export interface SwapParams extends QuoteParams {
     from: string
     slippage: number
     quoteMeta?: QuoteMeta
     chainId?: number
     recipient?: string  // NEW — output destination. Defaults to `from` when omitted.
   }
   ```

2. **Update `src/lib/api.ts`** — `fetchSwapFromSource()`:
   - Accept `recipient?: string` parameter
   - Pass it into the adapter's SwapParams
   - Default to `from` when not provided (preserves all existing behaviour)

3. **Update each adapter** to use `recipient ?? from`:

   - **cow.ts** — already has `receiver` field. Change `receiver: from` to `receiver: recipient ?? from`
   - **uniswapv3.ts** — change `recipient: from as Address` to `recipient: (recipient ?? from) as Address`
   - **balancer.ts** — change `receiver: from` to `receiver: recipient ?? from`
   - **kyberswap.ts** — change `recipient: from` to `recipient: recipient ?? from`
   - **velora.ts** — change `receiver: from` to `receiver: recipient ?? from`
   - **curve.ts** — change the `_receiver` arg to `recipient ?? from`
   - **1inch.ts** — check for `destReceiver` parameter and pass `recipient ?? from`
   - **0x.ts** — check for taker/recipient parameter
   - **odos.ts** — check for `receiver`/`userAddr` parameter
   - **openocean.ts** — check for `receiver` parameter
   - **sushiswap.ts** — check for `recipient` parameter

   For each adapter: if the underlying API supports a recipient field, use `recipient ?? from`. If it does NOT support recipient (unlikely), log a warning and fall back to `from`.

4. **Add tests:**
   - SwapParams with recipient → adapter receives correct recipient
   - SwapParams without recipient → adapter uses `from` (backwards compat)
   - Each adapter that supports recipient passes it to the external API

**Do NOT**

- Change the internal `/api/swap` endpoint — it continues to use `from` as recipient (frontend flow unchanged)
- Change FeeCollector logic — fee is taken from input amount, recipient only affects output destination
- Modify quote-only flows — `recipient` only matters at swap time, not quote time
- Change the `/api/swap/route.ts` recipient validation yet — that's for P102

**Files affected**

- `src/lib/adapters/types.ts` (add recipient to SwapParams)
- `src/lib/api.ts` (thread recipient through fetchSwapFromSource)
- `src/lib/adapters/cow.ts`
- `src/lib/adapters/uniswapv3.ts`
- `src/lib/adapters/balancer.ts`
- `src/lib/adapters/kyberswap.ts`
- `src/lib/adapters/velora.ts`
- `src/lib/adapters/curve.ts`
- `src/lib/adapters/1inch.ts`
- `src/lib/adapters/0x.ts`
- `src/lib/adapters/odos.ts`
- `src/lib/adapters/openocean.ts`
- `src/lib/adapters/sushiswap.ts`
- Test file for recipient threading

**Expected output**

- 1 atomic commit
- All adapters support optional recipient
- Backwards compatible — omitting recipient preserves existing behaviour
- Tests verify pass-through to each adapter

**Quality criteria**

- Zero impact on existing flows (recipient defaults to from)
- TypeScript compiles cleanly
- No adapter silently ignores recipient when it could pass it through

---

## Prompt 102 — v1/quote + v1/swap recipient field [Phase 2.1]

**Status:** Pending

**Context:** With P101's adapter-level recipient support in place, we need to expose it in the Public API. This enables third-party payment flows: integrators submit a swap where the output goes to a different address than the sender.

**Objective:** Add `recipient` parameter to v1/quote and v1/swap API endpoints.

**Requirements:**

1. **v1/quote** (`src/app/api/v1/quote/route.ts`):
   - Accept optional query param `recipient=0x...`
   - Validate: must be a valid 0x address if provided
   - Include in response metadata:
     ```json
     {
       "best": { ... },
       "all": [ ... ],
       "gasless": { ... },
       "meta": {
         ...,
         "recipient": "0x..." // echoed back, or null if not provided
       }
     }
     ```
   - The quote itself doesn't change based on recipient (same prices), but echoing it confirms the API understood the intent.

2. **v1/swap** (`src/app/api/v1/swap/route.ts`):
   - Accept optional body field `recipient`:
     ```typescript
     interface SwapRequestBody {
       tokenIn?: unknown
       tokenOut?: unknown
       amount?: unknown
       slippage?: unknown
       sender?: unknown
       source?: unknown
       recipient?: unknown  // NEW — output goes here. Defaults to sender.
     }
     ```
   - Validate: must be a valid 0x address if provided. Must NOT be the zero address.
   - Pass `recipient` to `fetchSwapFromSource()` (from P101)
   - **Update recipient validation:** When `recipient` is explicitly provided in the v1 request body, the `validateCallDataRecipient` check must compare against the provided `recipient`, not against `sender`. This is the key security change — the calldata recipient should match what the caller asked for.
   - Include in response:
     ```json
     {
       "to": "0xFeeCollector...",
       "data": "0x...",
       "value": "...",
       "gasEstimate": "...",
       "source": "1inch",
       "recipient": "0x...",  // echoed back
       "gasless": false
     }
     ```

3. **Security considerations:**
   - `sender` remains the address that signs + broadcasts the tx
   - `recipient` only affects where the swap OUTPUT goes
   - FeeCollector V2 collects from the INPUT — fee is unchanged regardless of recipient
   - Rate limiting is per API key (not per recipient) — no change needed
   - Do NOT allow recipient on the internal `/api/swap` endpoint — only on v1

4. **Add tests:**
   - v1/swap with recipient → calldata targets recipient, not sender
   - v1/swap without recipient → calldata targets sender (backwards compat)
   - v1/swap with recipient = zero address → 400 error
   - v1/swap with invalid recipient → 400 error
   - v1/quote with recipient → echoed in response meta
   - v1/quote without recipient → meta.recipient is null

**Do NOT**

- Change the internal `/api/swap` endpoint — it stays sender-only
- Add recipient to the frontend SwapBox flow — this is API-only for now
- Modify FeeCollector contract — fee collection is input-side, unaffected
- Allow recipient on the internal `/api/quote` endpoint

**Files affected**

- `src/app/api/v1/quote/route.ts`
- `src/app/api/v1/swap/route.ts`
- Test files for both routes

**Expected output**

- 1 atomic commit
- v1/quote accepts and echoes recipient
- v1/swap routes output to recipient when provided
- Backwards compatible — omitting recipient preserves existing behaviour
- Tests cover recipient present/absent/invalid scenarios

**Quality criteria**

- Existing v1 consumers don't break (no required params added)
- Recipient validation prevents zero address and invalid addresses
- Calldata verification updated to match expected recipient
- TypeScript compiles cleanly
- Security: sender still signs and pays gas + fee; only output routing changes

---

## Post-sprint

After all prompts are committed and CI green:
1. Run full test suite (expected: 554+)
2. Verify P103: `/api/stats` gasless block uses Supabase RPC (check no `.reduce()` in stats/route.ts)
3. Verify P104: `gas_savings_usd` capped at 500, derived from `bestNonCowGasUsd`
4. Test payment flow: `POST /v1/swap { sender: "0xAlice", recipient: "0xBob", ... }` → verify calldata routes output to Bob
5. Test backwards compat: `POST /v1/swap { sender: "0xAlice", ... }` (no recipient) → output goes to Alice
6. Test validation: recipient = zero address → 400, recipient = invalid → 400
7. Submit for auditor review — focus on: 13A-L-01/L-02 resolution, calldata recipient validation, FeeCollector interaction with non-sender recipient, security of sender≠recipient flow
8. After APPROVED: proceed to Sprint 13B (Personal Analytics)
