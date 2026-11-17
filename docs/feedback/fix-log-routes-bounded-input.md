## Feedback — fix/log-routes-bounded-input (SEC-3 High, SEC-8 Medium; audit of 2026-11-17 on origin/main 4a4129ef)

Long tables: [`fix-log-routes-bounded-input.tables.md`](fix-log-routes-bounded-input.tables.md).

### Owner answers (asked once, 2026-11-17; they supersede the goal text)
1. **Body cap:** `bodySizeGuard` stays synchronous with the same signature and header check, and also installs a
   byte-capped reader on the request. Routes I may edit answer 413 on overflow; `orders/route.ts`,
   `orders/[id]/route.ts` and `log-swap/route.ts` stay untouched (their reads also stop at the cap, they answer their
   own error). Routes that never read a body are unchanged.
2. **Size bounds (log-quote):** symbols ≤ 32 chars; tokenIn, tokenOut, wallet ≤ 64; amountIn, bestAmountOut ≤ 80;
   allQuotes = registry keys only, values ≤ 80 chars; responseTimeMs finite or 0. A value past its bound or of the
   wrong type is dropped like an absent one (a dropped required field answers 400, as a missing one does today).
3. **Test mock:** `smismember`, `srandmember`, `srem` may be added to `source-health-monitor.test.ts`'s kv mock, no
   assertion changed.

### Checklist
- [ ] Step 0: (a) 300 invented names → more failure events than registry sources; (b) chunked over-cap body accepted — both FAIL on origin/main, output below
- [ ] Change 1: log-quote keeps registry names only (one exported list), de-duplicated, capped; free text + allQuotes bounded
- [ ] Change 2: ≤ 1 failure event per registry source per request
- [ ] Change 3: source-health + /api/monitor iterate registry names only; bounded prune in the authenticated run
- [ ] Change 4: no operator alert carries a non-registry name
- [ ] Change 5: body-limit byte-capped reader, 413
- [ ] Tests: property (seeded), monitor 20,000 polluted names, body-limit cases + one e2e per route, swap-screen call unchanged
- [ ] Mutation proof (registry filter removed; reader cap removed)
- [ ] Verify: `scripts/agent-verify.sh --codeql`, `gen-claude-state --check`, lint delta 0
- [ ] Push, compare link
