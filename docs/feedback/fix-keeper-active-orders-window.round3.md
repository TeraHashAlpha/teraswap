# fix/keeper-active-orders-window — round 3 (A91: blocked 0C/2H at 16fb740c)

Keeper, fund-flow: Draft PR #714, **Auditor required**. Design `120c-details.md` (binding; `120b-details.md` where 120c
does not change it). Round-2 feedback: `fix-keeper-active-orders-window.md`. Tables T-R3-1..8: `…round3.tables.md`.
origin/main 85a6f9cb merged as `269dd983` (PR #709; no keeper file). Code: `358e62a7`, `ce55e768` (a comment).

## Owner answers (2026-11-18; they supersede the goal text and the details file)

Asked ONCE: one AskUserQuestion with four parts (1–4: the missing-row case, outages, the await-limit premise found
false, the re-ask budget), before the code that depended on them; no other question was asked. Answer 0 is not an
answer to a question: it is the owner's own message, sent after the goal started.

0. **Freeze read (message after the goal started): "error = frozen".** Only a well-formed answer saying not frozen lets a
   DCA order pass; a timeout, any error or any malformed answer means frozen for that cycle, with an ops alert and a
   /health field; this deliberately changes main. (The details file on disk, saved 17:48, still had the timeout-only
   R2-2 text; built from the owner's message.)
1. **No `dca` row** (HTTP 200, empty list) ⇒ frozen too; log/alert say the row is missing; runbook deploy check added.
2. **Outages: hostile-only.** A chunk failed by an RPC transport error (HTTP status, network, auth) is not bisected (rows
   to the 15-row budget, as in round 2); any other failure is bisected; a row is quarantined only when its gas-capped
   alone-ask fails with out of gas, a revert or its own time limit while another call of the cycle answered.
3. **Await limits added:** KMS 10 s, Supabase writes 10 s, POST /api/swap 65 s; each down the catch path it already had.
4. **Quarantine re-asks: own budget of 10 per cycle**, outside BISECT_CALL_BUDGET (40).
5. **After the push (the stop check held the goal on R2-2, whose binding text on disk was never updated):** asked
   "keep error = frozen, or revert to timeout-only?" — the owner chose **keep error = frozen**: the owner updates
   `120c-details.md` R2-2 / `120c-keeper-scan-round3.txt` line 11, or clears the goal by hand. No code change.

## Checklist

- [x] R2-1 no hold; bisect (40); quarantine (3,000,000 gas alone-ask, 30 min, 10/cycle); line, /health, alert at 5;
      complete scan on reads; expired still walked
- [x] R2-2 freeze read fails closed (answers 0, 1); table head vs main
- [x] Watchdog; await-limit table; limits (answer 3)
- [x] R2-3 fallback keeps carry list; ADR-026 note corrected · [x] R2-4 scan-wrap flag/count/alert; bound text
- [x] Tests failing on 16fb740c; Foundry (real Multicall3 + V3; 1, 2, 10 burners)
- [x] Property, differential (0), mutation (5/5) · [x] keeper Node 20 + 22 · [x] docs (ADR-024/026, 3 runbooks)
- [x] One agent-verify on the last code commit (`ce55e768`): PASS — see 6

## Evidence

1. **Per finding** (T-R3-1). R2-1 fixed: no hold `executor.js:1131,2036`; bisect `active-window.js:321`, `executor.js:1044`;
   quarantine `active-window.js:371`, `executor.js:1087,1099`; tests `active-scan-poison` (3), `active-scan-round3` R2-1 (8),
   `prescreen-bisect-replay` (5), Foundry `PrescreenBisect.t.sol` (6). R2-2 fixed `executor.js:1460-1495,1835-1854`, tests
   R2-2 (12). R2-3 fixed `:2818` + ADR-026 note, test R2-3. R2-4 fixed `:879,1990`, `active-window.js:519`, test R2-4.
   All 30 new behaviour tests FAIL on 16fb740c (T-R3-2; two only on the new /health field, behaviour equal to main);
   the output, verbatim: T-R3-2b.
2. **Bisect** (T-R3-3, gas model at 50M): worst delay of a healthy row — 24 burners among 600/1000/1200: **1/1/1** cycle
   (16fb740c: 26/27/never); 200 burners: **12/12/12** (16fb740c: 39/66/never). Budget: <= 7P calls per P burners
   (property), measured ~2.5 ⇒ ~16 isolated per cycle, >= 5 guaranteed; 10 burners in one chunk: 25 calls (50M), 21
   (550M). Foundry replay of the keeper's exact calls: every outcome matched the EVM; honest canExecute alone 14k–29k gas.
3. **Freeze read** (T-R3-5): head passes DCA only on `[{"frozen":false}]`; main passes on HTTP 503/404, network,
   not-JSON, not-a-list, non-boolean, empty list, a slow answer, and hangs on a read that never answers.
4. **Await limits + watchdog** (T-R3-4): every await has a limit (new: Supabase writes 10 s, /api/swap 65 s, KMS 10 s);
   watchdog at 5 min (alert once, `/health` `longCycles`, `cycleRunningSec`; fake-clock test); every-call-hanging tests end.
5. **Differential** 500 runs / 6000 cycles / 5096 fills vs origin/main: 0 differences. **Property** (deterministic): 20
   seeds × 80, 20,849 + 295 bound checks, 356 quarantined, 106 alone-asks none < 30 min, no double fill. **Mutants** 5/5
   killed (T-R3-6). Keeper `node --test`: 2183/2183 on Node 22 and on Node 20. Forge as CI: order-engine 130/130,
   contracts FeeCollector 19/19. **CHANGED EXPECTATIONS:** (a) `ACTIVE-SCAN-CYCLE.TEST.MJS:94` "THE SCAN HOLDS AT THAT
   CHUNK" ⇒ THE CHUNK IS BISECTED IN THE SAME CYCLE (SCREENED 100 ⇒ 150, PATH 15 ⇒ 0) AND THE NEXT SCAN STARTS AFTER THE LAST
   ROW READ; (b) "MULTICALL3 ABSENT": "ALL 40 ASKED" NOW COUNTS ROWS ASKED ALONE BY THE BISECT TOO, NOT THE PATH ALONE;
   (c) `quarantined=n` IN THE CYCLE LINE: 9 REGEXES/STRINGS (CYCLE ×3, WINDOW-CYCLE ×4, UNIT ×2); (d) THE `truncateScan` UNIT
   TEST REMOVED WITH IT; (e) PROPERTY BOUND: +CEIL(M/SCAN) (WAS +1) PER CYCLE THAT LEFT PRE-SCREEN ROWS UNRESOLVED,
   POISONED ROWS OUT OF THE SCREEN BOUND, "WHAT THE PRE-SCREEN SAID" = THE LAST ANSWER THE KEEPER RECEIVED, 1 MIN PER
   CYCLE; (f) THE FREEZE READ: MAIN'S FAIL-OPEN WAS PINNED BY NO EXISTING TEST; THE NEW TABLE EXPECTS FROZEN FOR 9 ANSWERS
   MAIN PASSES. Every other existing test is unchanged.
6. **Verify:** ONE `scripts/agent-verify.sh --keeper --codeql` on `ce55e768` (the last code commit), started 19:12:02Z at
   1-min load 7.13 with no other verify/CodeQL run (waited from load ~19), ended 19:20:19Z: **RESULT: PASS** — suite
   11170/0 failed (525 files), lint-delta +0/+0, tsc 0, build ok, v1v2-parity 123, rpc-budget 36, CodeQL security-extended
   head 13 = base 13 (0 new), keeper Node 20 2183/0/0 and Node 22 2183/0/0. Gitleaks on this round's commits: no leaks.
   Docs-only commits follow it (this file, the tables, the runbook § 1 tunables rows). Diff since 16fb740c: 43
   files, +4306/−273 at `ce55e768`. No CI command was run (no polling); no PR action.
   Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/keeper-active-orders-window. **Not verified:** a real
   provider's eth_call gas cap and its error shapes (gas model + Foundry at 50M/550M only); KMS against AWS (local
   stand-in); the Supabase write limit against a real PostgREST; whether production has the `dca` row (runbook check);
   the host; CI.
