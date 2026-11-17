# fix/keeper-active-orders-window — SEC-4 (keeper's 15-row active-orders window)

Keeper, fund-flow: Draft PR, **Auditor required**. Base: origin/main `4a4129ef`.

## Owner answers (asked once, 2026-11-17; they supersede the goal text)

One AskUserQuestion with four parts. Only one part came back answered; the goal says ask ONCE, so the
other three were not re-asked and the recommended option was built (marked "unanswered").

1. Keyset query rejected by Supabase (non-2xx) → **fall back to today's query (15 oldest) for that cycle**,
   log the status once per process, flag it on the per-cycle line. (answered)
2. MAX_BATCH / gas-SKIP stop vs the ceil(M/15) bound → cursor moves only past rows the loop reached; cut-off
   rows lead the next cycle; bound = ceil(M/15) + cycles that hit the cap or the gas stop. (unanswered)
3. M under churn in the property test → number of distinct rows active at any point in the observed
   cycles. (unanswered)
4. fetchActiveOrders' three per-fetch log lines (Supabase URL, row count, first order id + wallet prefix)
   → replaced by the one per-cycle line; "No active orders" / "Found N active order(s)" kept. (unanswered)

## Checklist

- [ ] Step 0: failing test on origin/main code (15 non-executable old rows + 1 newer executable row, 20 cycles)
- [ ] Pure helper beside executor.js (rows in; rows to examine + next cursor out)
- [ ] executor.js wiring: rotating keyset window, cursor in memory, wrap, restart at oldest
- [ ] Balance/allowance slow-down (3 consecutive answers ⇒ at most once per 10 min, in memory)
- [ ] One log line per cycle (active, examined, wrap; no address, no signature)
- [ ] Tests: Step 0 passes; seeded property; restart, empty, 15 rows, 1 row, equal created_at
- [ ] Existing keeper suite unchanged and green on Node 20 and 22
- [ ] Mutation proof: cursor frozen; slow-down on "interval not reached"; window doubled
- [ ] Verify: agent-verify --keeper --codeql; gen-claude-state --check
- [ ] Evidence 1-5 below; push; compare link
