# fix/keeper-active-orders-window — round 3 (A91: blocked 0C/2H at 16fb740c)

Keeper, fund-flow: Draft PR #714, **Auditor required**. Design `120c-details.md` (binding; `120b-details.md` where 120c
does not change it). Round-2 feedback: `fix-keeper-active-orders-window.md`. Companion tables: `…round3.tables.md`.
origin/main 85a6f9cb merged as `269dd983` (PR #709; no keeper file).

## Owner answers (2026-11-18; they supersede the goal text and the details file)

0. **Freeze read (message after the goal started): "error = frozen".** Only a well-formed answer saying not frozen lets a
   DCA order pass the freeze gate; a timeout, any error or any malformed answer means frozen for that cycle, with an ops
   alert and a /health field. This deliberately changes main's behaviour for read errors. (The details file on disk, saved
   17:48, still had the timeout-only R2-2 text; built from the owner's message.)
1. **No `dca` row** (HTTP 200, empty list) ⇒ frozen too; log and alert say the row is missing; the runbook's deploy check
   adds `select id, frozen from circuit_breaker`.
2. **Outages: hostile-only.** A chunk that failed with an RPC transport error (HTTP status, network, auth) is not
   bisected; its rows go to the 15-row budget as in round 2. Any other chunk failure (revert, out of gas, time limit) is
   bisected. A row is quarantined only when its own gas-capped ask fails with out of gas, a revert or its own time limit
   while another pre-screen call in the same cycle answered.
3. **Await limits: add explicit limits.** KMS sign 10 s, Supabase writes 10 s, POST /api/swap 65 s; each timeout goes
   down the catch path that call already has.
4. **Quarantine re-asks: own budget of 10 per cycle**, outside BISECT_CALL_BUDGET (40).

## Checklist

- [ ] R2-1 no hold on a failed chunk; bisect within 40 calls; quarantine (3,000,000 gas single ask, 30 min re-ask,
      10 re-asks/cycle); `quarantined=n`, /health, alert at 5; complete scan without quarantined rows; expired still walked
- [ ] R2-2 freeze read fails closed (owner answers 0, 1): table head vs main
- [ ] Watchdog (> 5 min: warn alert + /health) and the await-limit table (owner answer 3)
- [ ] R2-3 fallback cycle keeps the carry list; ADR-026 note corrected
- [ ] R2-4 failed wrap read: `fallback=scan-wrap`, /health, alert; bound text (fallbacks, failed wraps, restarts)
- [ ] Tests failing on 16fb740c first (output in the tables file); Foundry with real Multicall3 + V3 (1, 2, 10 burners)
- [ ] Property (seeded), differential vs origin/main (M <= 15) = 0, mutation proof (the goal's five)
- [ ] Keeper suite Node 20 + 22; docs (ADR-024/026 notes, both runbooks, DCA-FREEZE)
- [ ] One agent-verify --keeper --codeql on the last code commit (load < 10); evidence 1-6; push
