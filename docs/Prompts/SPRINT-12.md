# Sprint 12 — LOW Findings Cleanup

**Sprint window:** Post-Sprint 11.5 APPROVED → TBD
**Sprint goal:** Close all 4 remaining LOW findings from the Sprint 11 audit. Pure defence-in-depth — no new features, no contract changes. After this sprint, the entire Sprint 11 audit backlog is at zero.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 11.5 APPROVED (0C/0H/0M/0L, 2026-05-13).
**References:**
- Sprint 11 audit: `Audits/Sprint/audit-sprint-11.md` (findings 11-L-01 through 11-L-05)
- Note: 11-L-04 (admin env var leak) was already fixed in the 11-M-02 sweep. Only 4 findings remain.

---

## RICE Prioritisation

| # | Prompt | R | I | C | E | RICE | Priority |
|---|--------|---|---|---|---|------|----------|
| 90 | SwapBox + split-router + useSplitRoute safeBigInt sweep | 10 | 2 | 1.0 | 1.0 | 20.0 | P1 |
| 91 | cow.ts validator ordering | 4 | 2 | 1.0 | 0.25 | 32.0 | P1 |
| 92 | quoteMeta typed union | 8 | 2 | 0.8 | 1.5 | 8.5 | P2 |
| 93 | Admin rate limit upper bound | 6 | 2 | 0.9 | 0.5 | 21.6 | P1 |

**Execution order:** P90 → P91 → P92 → P93 (no dependencies — can also run in any order)

---

## Sprint status table

| # | Prompt | Description | Finding | Status |
|---|--------|------------|---------|--------|
| 90 | safeBigInt sweep (SwapBox + split-router + useSplitRoute) | Migrate all bare BigInt() to safeBigInt() | 11-L-01 | Pending |
| 91 | cow.ts validator before BigInt | Move parseCowOrderParams before BigInt conversion | 11-L-02 | Pending |
| 92 | quoteMeta typed union | Replace Record<string, any> with per-adapter typed interfaces | 11-L-03 | Pending |
| 93 | Admin rate limit upper bound | Cap rateLimitPerMin and rateLimitPerDay with hard maximums | 11-L-05 | Pending |

---

## Prompt 90 — safeBigInt sweep: SwapBox + split-router + useSplitRoute [11-L-01]

**Status:** Pending

**Context:** P75 (Sprint 11) migrated 6 files from bare `BigInt()` to `safeBigInt()` but left `SwapBox.tsx` (11 call-sites), `split-router.ts` (7 call-sites), and `useSplitRoute.ts` (1 call-site) out of scope. `safeBigInt()` from `@/lib/utils` returns `null` instead of throwing on malformed input. The auditor flagged this inconsistency as 11-L-01.

**Objective:** Replace all bare `BigInt()` calls in these 3 files with `safeBigInt()`, with appropriate null-handling per context.

**Requirements:**

1. **`src/components/SwapBox.tsx`** — 11 bare `BigInt()` calls at lines 124, 125, 130, 175, 269, 272, 370, 406, 760, 761, 835.

   Import `safeBigInt` from `@/lib/utils` and replace each call with context-appropriate fallback:
   - **Display/formatting contexts** (L175, L269, L272, L370, L406, L760, L761, L835): if `safeBigInt()` returns `null`, degrade gracefully — show `'—'` or `'0'` in the UI. Never crash the component.
   - **Comparison/logic contexts** (L124, L125, L130): if `safeBigInt()` returns `null`, skip the comparison (e.g. MEV preference cannot be computed → use default behaviour).

2. **`src/lib/split-router.ts`** — 7 bare `BigInt()` calls at lines 32, 61, 93, 119, 136, 173, 239.

   Replace with `safeBigInt()`. For this file:
   - L32 (`totalAmount`): if null, return early with empty split result
   - L61 (`pct`): if null, skip this percentage split
   - L93, L119, L136, L173, L239 (output comparisons): if null, treat as 0n for comparison (worst case = route not selected, graceful degradation)

3. **`src/hooks/useSplitRoute.ts`** — 1 bare `BigInt()` at line 51.

   Replace with `safeBigInt()`, fallback to `0` display value.

4. **Add tests:**
   - Test SwapBox rendering when `meta.best.toAmount` is `undefined`, `""`, `"NaN"` — component should render without crashing, display fallback
   - Test split-router with malformed `totalAmount` — should return empty result, not throw
   - Test useSplitRoute with malformed `toAmount` — should not crash

**Do NOT**

- Modify `safeBigInt()` itself — it's stable since P75
- Change any business logic — only replace the conversion mechanism
- Use `try/catch` around `BigInt()` — that's what `safeBigInt()` replaces
- Touch files already migrated in P75

**Files affected**

- `src/components/SwapBox.tsx`
- `src/lib/split-router.ts`
- `src/hooks/useSplitRoute.ts`
- Test files for the above (create if not exist)

**Expected output**

- 1 atomic commit
- Zero bare `BigInt()` calls remaining in these 3 files
- `grep -rn 'BigInt(' src/components/SwapBox.tsx src/lib/split-router.ts src/hooks/useSplitRoute.ts` returns zero results (only `safeBigInt` or `0n`/literal bigints)
- All existing tests still pass
- New tests cover null/undefined/malformed inputs

**Quality criteria**

- No `BigInt()` without `safe` prefix in any of the 3 files
- UI doesn't crash on malformed toAmount
- Split router degrades gracefully on bad input
- TypeScript compiles cleanly

---

## Prompt 91 — cow.ts validator ordering [11-L-02]

**Status:** Pending

**Context:** In `src/lib/adapters/cow.ts` line 193, `BigInt(quote.buyAmount)` is called before `parseCowOrderParams` (L201). If the CoW API returns a non-numeric `buyAmount`, the throw happens before validation can reject gracefully. The adapter-level catch handles it (CoW drops from the round), but the ordering is wrong — validate first, then convert.

**Objective:** Reorder so that `parseCowOrderParams` validates the CoW response before any `BigInt()` conversion.

**Requirements:**

1. **Reorder lines 193-209** in `src/lib/adapters/cow.ts`:

   **Before (current):**
   ```typescript
   const buyAmountBig = BigInt(quote.buyAmount)          // L193 — can throw
   const slippageFactor = BigInt(...)                      // L194
   const minBuyAmount = (buyAmountBig * slippageFactor / 10000n).toString()  // L195
   
   const cowOrderParams = parseCowOrderParams(quote, {    // L201 — validates
     ...
     buyAmountOverride: minBuyAmount,                     // depends on L195
   })
   ```

   **After:**
   ```typescript
   // [11-L-02] Validate CoW response BEFORE BigInt conversion.
   // parseCowOrderParams checks shape, types, and ranges.
   const cowOrderParams = parseCowOrderParams(quote, {
     from: from as `0x${string}`,
     quoteId: quoteData.id,
     signingScheme: 'eip712',
   })
   if (!cowOrderParams) {
     throw new Error('CoW: malformed /quote response — see console for the offending field')
   }

   const buyAmountBig = safeBigInt(quote.buyAmount)
   if (buyAmountBig === null) {
     throw new Error('CoW: buyAmount is not a valid integer')
   }
   const slippageFactor = BigInt(Math.round((1 - clampSlippage(slippage) / 100) * 10000))
   const minBuyAmount = (buyAmountBig * slippageFactor / 10000n).toString()
   ```

   Note: `buyAmountOverride` moves to after the BigInt conversion. Update `parseCowOrderParams` call or apply the override after validation — whichever is cleaner. The key constraint is: **validate → convert → compute**.

2. **Import `safeBigInt`** from `@/lib/utils` if not already imported.

3. **Add test:**
   - Mock CoW API returning `buyAmount: "not_a_number"` → adapter should throw tagged error, not SyntaxError
   - Mock CoW API returning malformed quote shape → `parseCowOrderParams` rejects before BigInt

**Do NOT**

- Change `parseCowOrderParams` implementation — only the call order
- Remove the existing adapter-level catch
- Modify any other adapter

**Files affected**

- `src/lib/adapters/cow.ts`
- Test file for cow adapter (create or extend)

**Expected output**

- 1 atomic commit
- `parseCowOrderParams` called before any `BigInt()` on CoW response data
- `safeBigInt` used for `quote.buyAmount` conversion
- Test proves validation-first ordering

**Quality criteria**

- Malformed CoW response → clean tagged error, not SyntaxError
- Normal CoW flow unchanged (existing tests pass)
- TypeScript compiles cleanly

---

## Prompt 92 — quoteMeta typed union [11-L-03]

**Status:** Pending

**Context:** `src/lib/adapters/types.ts` line 119 defines `quoteMeta?: Record<string, any>`. This was acceptable when only 1-2 adapters used it, but now it's a type-safety gap — any adapter can inject untyped data that flows through the pipeline without validation.

**Objective:** Replace the `any`-typed `quoteMeta` with a discriminated union of per-adapter interfaces.

**Requirements:**

1. **Define per-adapter meta interfaces** in `src/lib/adapters/types.ts`:

   ```typescript
   export interface CowQuoteMeta {
     source: 'cow'
     orderId?: string
     quoteId?: string | number
   }
   
   export interface UniswapV3QuoteMeta {
     source: 'uniswapv3'
     uniswapV3Fee?: number
   }
   
   // Generic fallback for adapters that don't use quoteMeta yet
   export interface GenericQuoteMeta {
     source: string
     [key: string]: unknown  // `unknown` not `any` — forces type checking at use-site
   }
   
   export type QuoteMeta = CowQuoteMeta | UniswapV3QuoteMeta | GenericQuoteMeta
   ```

2. **Update `SwapParams`** line 119:
   ```typescript
   quoteMeta?: QuoteMeta
   ```

3. **Update consumers** that set or read `quoteMeta`:
   - `src/lib/adapters/uniswapv3.ts` (L314): reads `params.quoteMeta?.uniswapV3Fee` — needs type narrowing (`if (params.quoteMeta?.source === 'uniswapv3')`)
   - `src/lib/api.ts` (L245, L256): passes quoteMeta through — update type annotation
   - Any adapter that sets quoteMeta should include `source` discriminator

4. **No runtime changes** — this is a type-level refactor. The `source` discriminator enables type narrowing at compile time.

**Do NOT**

- Add runtime validation for quoteMeta (that's a separate concern)
- Change how adapters actually populate quoteMeta — only add types
- Break the existing flow — if an adapter doesn't set `source`, the `GenericQuoteMeta` type catches it via `[key: string]: unknown`
- Use `any` anywhere in the new types

**Files affected**

- `src/lib/adapters/types.ts`
- `src/lib/adapters/uniswapv3.ts`
- `src/lib/api.ts`
- Any adapter that sets quoteMeta fields

**Expected output**

- 1 atomic commit
- Zero `any` in quoteMeta typing
- All existing tests pass (no runtime changes)
- TypeScript compiles cleanly with stricter types

**Quality criteria**

- `grep -rn 'Record<string, any>' src/lib/adapters/types.ts` returns zero matches
- Type narrowing works at consumer sites (e.g. `quoteMeta.uniswapV3Fee` only accessible after `source === 'uniswapv3'` check)
- No `as any` casts introduced to satisfy the compiler

---

## Prompt 93 — Admin rate limit upper bound [11-L-05]

**Status:** Pending

**Context:** `src/app/api/admin/api-keys/route.ts` lines 121-128 accept any positive integer for `rateLimitPerMin` and `rateLimitPerDay`. An admin could accidentally create a key with `rateLimitPerMin: 999999999`, effectively unlimited. The auditor recommended hard caps.

**Objective:** Add upper bounds to admin-configurable rate limits.

**Requirements:**

1. **Define constants** at the top of the route file (or in a shared config):
   ```typescript
   const MAX_RATE_LIMIT_PER_MIN = 10_000
   const MAX_RATE_LIMIT_PER_DAY = 1_000_000
   ```

2. **Add validation** in the POST handler (around lines 121-130):
   ```typescript
   const rateLimitPerMin =
     typeof body.rateLimitPerMin === 'number' &&
     Number.isInteger(body.rateLimitPerMin) &&
     body.rateLimitPerMin > 0 &&
     body.rateLimitPerMin <= MAX_RATE_LIMIT_PER_MIN
       ? body.rateLimitPerMin
       : limits.perMin

   const rateLimitPerDay =
     typeof body.rateLimitPerDay === 'number' &&
     Number.isInteger(body.rateLimitPerDay) &&
     body.rateLimitPerDay > 0 &&
     body.rateLimitPerDay <= MAX_RATE_LIMIT_PER_DAY
       ? body.rateLimitPerDay
       : limits.perDay
   ```

   If the value exceeds the cap, fall back to tier defaults (don't error — this makes it safe for honest mistakes).

3. **Add response feedback** — when admin passes a value that's capped, include it in the response:
   ```typescript
   // In the response object, add:
   warnings: [
     ...(body.rateLimitPerMin > MAX_RATE_LIMIT_PER_MIN ? [`rateLimitPerMin capped at ${MAX_RATE_LIMIT_PER_MIN}`] : []),
     ...(body.rateLimitPerDay > MAX_RATE_LIMIT_PER_DAY ? [`rateLimitPerDay capped at ${MAX_RATE_LIMIT_PER_DAY}`] : []),
   ].filter(Boolean)
   ```

4. **Add tests:**
   - Create key with `rateLimitPerMin: 50000` → should cap to tier default (or 10000 if explicit)
   - Create key with `rateLimitPerMin: 100` → should accept as-is
   - Create key with `rateLimitPerDay: 2000000` → should cap
   - Verify warnings array in response when capped

**Do NOT**

- Reject the request outright — cap silently with a warning, don't error
- Change tier defaults in any existing tier definition
- Modify the GET or DELETE handlers
- Add an "unlimited" override flag (keep it simple — if we need unlimited, we raise the constant)

**Files affected**

- `src/app/api/admin/api-keys/route.ts`
- Test file for admin API keys (extend existing)

**Expected output**

- 1 atomic commit
- Hard caps prevent accidental unlimited keys
- Warnings in response when values are capped
- Tests verify cap behaviour

**Quality criteria**

- `rateLimitPerMin: 999999999` → capped to `10000` (or tier default)
- `rateLimitPerMin: 100` → accepted as `100`
- Response includes `warnings` array when capped
- No breaking changes to existing key creation flow

---

## Post-sprint

After all prompts are committed and CI green:
1. Verify zero bare `BigInt()` in codebase: `grep -rn 'BigInt(' src/ --include='*.ts' --include='*.tsx' | grep -v safeBigInt | grep -v '0n' | grep -v node_modules | grep -v '.test.'` — should return only intentional uses (e.g. `BigInt(Math.round(...))` for known-safe numeric inputs)
2. Verify zero `any` in quoteMeta: `grep -rn 'Record<string, any>' src/lib/adapters/types.ts` — zero matches
3. Run full test suite (expected: 521+)
4. Submit for auditor review
5. After APPROVED: Sprint 11 audit backlog = zero. All future work is Phase 2 features.
