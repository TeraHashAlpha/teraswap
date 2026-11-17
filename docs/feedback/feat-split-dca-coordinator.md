# feat/split-dca-coordinator — FEEDBACK (no PR; Draft PR + Auditor required: fund-flow, keeper decision path)

Goal: the Split DCA ("basket") data model and a COORDINATOR module with injected I/O, which turns one basket, its three
order rows and the journal into "the picks executable now". `executor.js` is not changed and nothing calls the
coordinator yet: the keeper behaves as today. Long tables: `feat-split-dca-coordinator.evidence.md`.

**Round 2 (2026-11-17): the fixes for the audit of `6023579a` (blocked 0C/3H) are the LAST section of this file**
("Round 2"), with their tables in the evidence file's section R2. Statements below that round 2 changed are marked
"[superseded by round 2]" where they stand.

Model: CONTROL says Opus, effort high. **This goal was NOT run on Opus**: the whole of it ran in the owner's session,
which is set to Fable 5.2. I did not ask about it for this goal; I relied on the owner's answer to the same question
earlier the same day, recorded in `docs/feedback/feat-basket-selection-reference.md` ("Model. CONTROL says Opus; the
session was set to Fable 5.2 just before the goal. Owner: run here, on Fable 5.2", merged with PR #701). The stop
check named this as unmet, rightly: an answer given for another goal is not an instruction for this one. Asked for
this goal (2026-11-16, second question, on the model line alone), **the owner accepted it as run on Fable 5.2**
(answer 5 below). Nothing was re-run.

Required reading, and what the code took from it: spec §2 to §6 and ADR-027 (the pack's copies, §1); the
`decideTick` contract of `basket-scheduler.js` (the state it takes, `perLeg`, `next`, its throws); `price-sources.js`
(`createCycleQuoteContext`, `legQuotes`: quotes as `{ price, ts, source }`, a source that fails is absent, the injected
`now` is unix SECONDS, which `deps.now` follows) and `order-floor.js` (`resolveFloorPrice`: quorum, single, skip), for
the shape of `resolvePrice`; the last three migrations and `contracts/order-engine/CLAUDE.md`; and in `executor.js`:
`supabaseFetch` (`:652-664`, it returns the response and does NOT throw on a non-2xx), `fetchActiveOrders`
(`:666-685`, `status = active` only, at most `MAX_BATCH × 3` rows), the lock (`:687-705`, `:1494`) and the DCA
due-time check. That check is not in the keeper at all: every active DCA order is locked each cycle and the CONTRACT
is asked (`canExecute`, `:1616-1627`); "not yet" unlocks the order and skips it, with no retry count. `dcaDueSec`
(`deviation-guard.js:113-130`) is only the scheduled time the deviation guard's defer window starts from
(`executor.js:1890-1929`).

Base: `origin/main` `4a4129ef` (PR #705). Main moved twice during the work (`b47ca15e` → `ace16fa7` with PR #704, →
`4a4129ef` with PR #705); the commits, not yet pushed then, were rebased each time with no conflict.

## Owner answers (2026-11-16; they supersede the goal text)
The first push (`eb164897`) had chosen four readings without asking and had changed `schema.sql` against the goal's
"no change to … contracts". The stop check refused that exit, rightly: the goal says to ask. One dialog, four parts:

1. **The `contracts/order-engine/schema.sql` mirror of the migration: keep it.**
2. **Until when may a tick be decided?** The rule "a tick whose time passed with no row is never decided late" names
   no deadline; I had built "until the next tick's time". **Owner: until tick time + T/2.** Changed in commit
   `caececae`: from `+ T/2` on, a tick with no row is missed (reason `tick_missed`) and never gets one.
3. **Three readings, all as built:** `expired` is written when the last grace tick's WINDOW ends (`t0 + (N + 4) × T`
   in `'reference'` mode); a fail-closed reason is returned to the caller for its log and is not journaled; a basket
   first seen a moment before `t0` still gets its reference row.
4. **Three differences from the goal's letter, all accepted:** RLS copies only the read policy of `orders`;
   `baskets.stable_leg` is added although spec §5 does not list it; commit 1 no longer contains the spec/ADR copy,
   because PR #704 merged the same bytes to main meanwhile (§1).

A second question, on its own, after the stop check refused the exit on the CONTROL line:

5. **CONTROL says "model Opus, effort high"; the goal ran in this session on Fable 5.2.** Offered: accept as run, have
   an Opus agent re-implement commits 2 to 4 for comparison, or have an Opus agent review the diff read-only.
   **Owner: accept as run on Fable 5.2.**

For the Architect: the spec's Coordinator rule still reads "a tick whose time passed with no row is never decided
late"; answer 2 gives it its deadline, "a tick is decided only before its time + T ÷ 2".
**[superseded by round 2, S-10]** Stale when the audit read it: the pack's spec already had the deadline ("A tick may
be decided only from its time until its time + `T ÷ 2`"). Round 2 copies that spec over the repo copy, byte for byte.

## Checklist
- [x] Commit 1 `28bf0da9`: this file, with the goal's checklist. The copy of the spec and ADR-027 is no longer in it: see §1
- [x] Commit 2 `814963a4`: migration `baskets`, `basket_ticks`, `orders.basket_id` (a file only; no database touched)
- [x] Commit 3 `6b7e815a`: `contracts/order-engine/executor/basket-coordinator.js`
- [x] Commit 4 `6ecbe7cf`: tests (node:test, Node 20 and 22), engine vectors replayed through the coordinator, one test per rule
- [x] First push at `eb164897` (commits 1 to 4 and the feedback); then the question above
- [x] Commit 6 `caececae`: the owner's answer 2, a tick is decided only before its time + T/2 (module and tests)
- [x] Mutation proof in a scratch copy: the goal's five in 18 forms, and 70 more; 88 of 88 killed on both Nodes (§4)
- [x] Verify: `scripts/agent-verify.sh --keeper --codeql` **RESULT: PASS**, 8 of 8; `node scripts/gen-claude-state.mjs --check` current (§5)
- [x] Push `feat/split-dca-coordinator` (fast-forward, no force), compare link (§5)

## 1 sha256 pairs (commit 1)
Copied with `cp`, compared with `cmp` (identical) and hashed with `shasum -a 256`:

| File | Architect pack (`~/Desktop/teraswap-architect-pack/basket/`) | Repo copy |
|---|---|---|
| `docs/Prompts/SPEC-BASKET-DCA.md` (18 989 bytes) | `daa33be5bd0f45418b4ebd06955a8f3c0238a42c603a10f47f320264d9d11e0d` | `daa33be5bd0f45418b4ebd06955a8f3c0238a42c603a10f47f320264d9d11e0d` |
| `docs/ADR/ADR-027-basket-dca-three-orders.md` (8 027 bytes) | `26eaa85460036a59cf444bd5e321d34e4842ae556b111c85a16c719e178d65d1` | `26eaa85460036a59cf444bd5e321d34e4842ae556b111c85a16c719e178d65d1` |

When the branch started (`b47ca15e`) the repo held `8a3cbc01…c37b` (spec) and `50cb00b1…0e8c` (ADR), the versions of
PR #687, and the first commit replaced them and regenerated `CLAUDE.md`'s state block ("Status: Proposed" had become
"Status: Accepted"). **While the branch was being written, PR #704 merged the same two files to main**: its copies
hash to the same two values (`git show origin/main:<path> | shasum -a 256`). After the rebase the copy is therefore
not a change any more, and the first commit holds this file only. The pairs above were re-measured after the rebase:
pack = repo = main.
**[superseded by round 2, S-10]** The pack's spec has changed since (the deadline, then the block "Added after the
audit of 2026-11-16"); round 2 copies it again. The new pair is in the Round 2 section.

## 2 Schema (commit 2)
`supabase/migrations/20261116120000_baskets_split_dca.sql`: two new tables, one new nullable column on `orders`, two
read policies. Every column with its reason: evidence §2. In short:

- `baskets`: the columns of spec §5, plus `first_buy` (`'reference'` default, or `'now'`), plus `stable_leg` (which leg
  the peg band applies to: the coordinator and the selection module both need it and §5 does not list it). The leg
  ORDER is in the column names (`leg0_…`, `leg1_…`, `leg2_…`: token_out, weight_num, weight_den, n, order_hash).
  `t0` is BIGINT unix seconds, the unit of `orders.expiry`.
- `basket_ticks`: `tick` (-1 = the reference row), `decided_at`, `leg{0,1,2}_price` DOUBLE PRECISION and
  `leg{0,1,2}_price_source`, `band_add` DOUBLE PRECISION, and the module's output as returned in three JSONB columns:
  `per_leg`, `picks` (with slot), `next_state`; `idle_reason`. `UNIQUE (basket_id, tick)`. A CHECK keeps the reference
  row free of decision columns and a tick row complete.
- `orders.basket_id`: UUID, NULL, no default, references `baskets(id)`.
- No visitor data: nothing about the browser, the request or the session in either table.
- RLS enabled on both; a user may only SELECT their own rows, on the wallet claim `orders` uses.

**The SQL was not run anywhere.** The goal forbids touching a database, and this Mac has no PostgreSQL and no
PostgreSQL parser (`psql`, `postgres`: not found; nothing in `node_modules`). What stands in for a run: the file was
read statement by statement against PostgreSQL's rules (three-valued logic in every CHECK over a nullable column,
operator precedence around `IS NULL`, NaN ordering in the price checks), and `basket-coordinator.test.mjs` pins its
text: the column sets against the row the coordinator writes and the rows it reads, DOUBLE PRECISION on the four
doubles, no NUMERIC anywhere, the unique key, the value lists against the code's constants, the only ALTER of an
existing table, and the mirror in `schema.sql`. The owner (or a staging project) is the first to execute it.

`contracts/order-engine/schema.sql` is the one existing file this branch changes outside `docs/`: the migration's body
is appended to it unchanged, because the last three migrations all say "mirrored in contracts/order-engine/schema.sql"
and `infra-miss-ladder.test.mjs` holds the previous one to it. The goal says "no change to … contracts"; asked, the
owner chose to keep the mirror (answer 1).

## 3 The coordinator (commits 3 and 6)
`coordinateBasket({ basket, orders, inFlight }, { now, db, resolvePrice })`, one call per poll per basket. It returns
`{ picks, wrote, reason, detail, failClosed, tick, basketId }`: the picks executable NOW as
`{ orderId, leg, tick, slot, kind }`, the rows it stored, and a reason whenever there is no pick. It never throws:
whatever goes wrong is `{ picks: [], reason, failClosed: true }`. The full decision table (18 rows, the state the
module gets, which picks are executable, what a failure leaves behind) is evidence §3. Each Coordinator rule, as built:

| Rule | As built |
|---|---|
| Reference row, `T/2` deadline | `'reference'` mode, first sight strictly before `t0 + T/2`: the three prices as journal tick -1, prices only. At `t0 + T/2` or later: never written, and tick 0 runs with `last` null. Written once: a later sight reads it |
| Tick times | `'reference'`: `t0 + (t + 1) × T`; `'now'`: `t0 + t × T`; `t = 0 … N + 2`; second slot `+ T/2` |
| State from rows | every call starts from the rows alone, in whatever order the database returns them: `last` = latest row with a price (reference included), `entry` = first TICK row with a price, `cooldown` = the previous tick's stored next-cooldown (none if that tick has no row), `done` = the order rows |
| Decide once | a row for the current tick is read; no price is resolved and nothing is decided |
| Write before return | the decision is inserted first; the picks are computed from the row the database answered with; a failed or unconfirmed insert returns no pick |
| Slot timing | slot 1 from the tick time, slot 2 from `+ T/2`, both until the next tick's time; per leg only its next outstanding slot; a pick the order row shows as executed is not offered again |
| Missed tick | a tick is decided only from its time until strictly before its time `+ T/2` (owner, answer 2). From `+ T/2` on a tick with no row is missed (`tick_missed`): no price is resolved, no row is ever written, whatever kept it from being decided. Only the current tick is ever decided. The next decision finds no previous row: cooldown none, `last` and `entry` unchanged |
| In-flight block | no decision while any leg has a transaction in flight (if that lasts to `+ T/2`, the tick is missed); a leg in flight is not offered; an order row that is `executing` counts as in flight |
| Stable pair | `resolvePrice(token, { stable: true })` must return the price with its `bandAdd`; a price alone is refused |
| Fail closed | missing or unreadable basket, mismatched leg order (row and signed `order_data`), unreadable journal, clock not in seconds or behind the journal, resolver error, selection-module error, failed write: no pick, a reason, nothing written |
| Status | `completed` when every leg has `dca_executed ≥ n` (checked first); `expired` once `now ≥` the end of the last grace tick's window, unless a transaction is still in flight |

**[superseded by round 2]** for "Stable pair" (the hint is now `{ stable, chainId }`, S-3) and "Fail closed" (also a
foreign chain, S-3, and a leg with chunks left that cannot execute, S-2). The table as it stands now: evidence R2.2.

Where the rules left a choice, as settled by the owner's answers (each is in the decision table and pinned by a test):
- **"A tick whose time passed … never decided late"**: a tick is decided only before its time `+ T/2` (answer 2). I had
  first built "until the next tick's time", the window in which its picks are executable; that is now a mutant the
  tests kill (§4, G4a).
- **"Expired after the last grace tick"** is after that tick's WINDOW, one `T` after its time (`t0 + (N + 4) × T` in
  `'reference'` mode): the spec's expiry formula keeps "one cycle of room for the last second slot", and an earlier
  cut would make the last grace tick's picks unexecutable (answer 3).
- **"With a recorded reason"**: the reason is in the result of the call, for the caller's log. It is not a journal row
  (evidence §3.5; answer 3).
- **First sight before `t0`** (a keeper clock a moment behind the server's): the reference is written; the rule gives
  only the upper bound (answer 3). **[superseded by round 2, S-6]** the spec now gives a lower bound too: not more
  than `REFERENCE_CLOCK_SKEW_S` (60 s) before `t0`.

## 4 Tests and mutation proof (commits 4 and 6)
`contracts/order-engine/executor/basket-coordinator.test.mjs`, node:test, 462 tests in 15 suites (458 at the first
push; 4 came with the owner's deadline). The database is an in-memory fake that passes every row through JSON in both
directions (as PostgREST does), returns the journal newest first, and enforces `UNIQUE (basket_id, tick)`; every poll
is a fresh `coordinateBasket` call on fresh row copies.

| | Node 20.20.2 | Node 22.23.5 |
|---|---|---|
| `basket-coordinator.test.mjs` | 462 pass, 0 fail, 0 cancelled | 462 pass, 0 fail, 0 cancelled |
| Whole keeper suite (`node --test`, 54 files) | 2025 pass, 0 fail, 0 cancelled | 2025 pass, 0 fail, 0 cancelled |

(1 563 keeper tests before this branch.) What the 462 are:

- **Engine vectors through the coordinator, 385 tests.** Each of the 96 run vectors of `fixtures/basket-dca/` is
  replayed four ways, with a poll at the reference and four polls inside every tick (at +3 s, `T/2` - 1 s, `T/2`,
  `T` - 1 s), executing each offered pick on the order row:
  - `'reference'` mode: the journal equals the selection module alone, row for row (picks, perLeg, next, idle reason),
    every decided pick comes out as executable exactly once and never before its slot time, and the fills, done, idle
    reasons and per-leg values are the ENGINE's (`expected` of the fixture), the decision prices bit for bit;
  - `'now'` mode: the same against the module with no reference (and against the engine for the 12 vectors that have
    none);
  - with about 30% of the ticks missed, half of them never polled and half polled only from `+ T/2` on (each such
    poll must answer `tick_missed`): the module with no prices at those ticks, and no row for them, ever;
  - with about 25% of (tick, leg) refusing to execute: the module with those chunks not executed (done from the orders).
- **One test per Coordinator rule, 64 tests in 12 suites**, named after the rule. The ones the goal lists: restart
  between the row write and the execution; two calls for the same tick; a missed tick; reference seen too late; slot 2
  before and after its time; in-flight block; journal write failure; a leg order that does not match (28 cases);
  `decideTick` throwing (a real throw of the real module: a variation that is not finite); `'now'` mode with leg 0
  unpriced. Also: two keepers racing on one tick, the picks read from the row as stored, an unreadable basket (34
  cases), an unreadable journal (25 cases), a clock in milliseconds, errors nobody foresaw, both status transitions.
  For the deadline: decided at +0, +1 and `T/2` - 1 s, missed at `T/2`, `T/2` + 1 and `T` - 1 s, in both modes; a
  keeper back after `+ T/2`; a price read, a selection error and a write that fail until the deadline; a transaction
  in flight past it.
- **The module itself, 4 tests**: its only import is the selection module; no clock, timer, network, environment or
  module-level variable; `executor.js` does not mention it.
- **The migration as text, 9 tests** (§2).

**Mutation proof.** A scratch copy outside the repo, one exact string replacement per mutant (each checked to occur
exactly once), the test file run on every mutant with a reporter that lists the failing tests. **88 mutants, 88
killed, 0 survived, on Node 22.23.5 and on Node 20.20.2**, the same failing tests on both. Every mutant is killed by
at least one rule test by name, not only by the vector replays. The goal's five, in 18 forms (the count is failing
tests of 462; in brackets, how many of them are vector replays; every name and the other 70 mutants: evidence §4):

- **Decide twice.** G1a, the current tick's row is ignored: 396 (384). G1b, and the refused duplicate write is
  swallowed so the new decision executes: 172 (158). Both fail
  `two calls for the same tick: the second reads the row and never decides again, even when the prices have changed`,
  `restart between the row write and the execution: the stored picks come back, nothing is decided again` and
  `two keepers on one tick: the one whose write loses executes nothing; its next poll reads the winner's row`.
- **Return before writing.** G2a, the decision is never written: 430 (385). G2b, a failed write is ignored: 4,
  among them `journal write failure: nothing executes and nothing is reported as written; the next poll decides`,
  `two keepers on one tick: …` and `it never throws and never returns a pick, whatever it is given`. G2c, the picks
  come from the decision in memory, not from the stored row: 3,
  `the row is in the database before the call returns, and the picks are read from the row AS STORED`,
  `an insert the database does not confirm with the row is a failed write: no row back, the wrong tick, or a malformed row`
  and `an error nobody foresaw is still fail closed (internal_error), never a rejection: …`. G2d, the write is started
  and not awaited: 8, among them the two tests of G2c and `journal write failure: …`.
- **Entry from the reference row.** G3a, the reference row counts for `entry`: 282 (252). G3b, the same from tick 1
  on only (so the module's own tick 0 check does not catch it): 251 (246). Both fail
  `entry is the first TICK row's price, never the reference row's: 30% under the reference at the first tick is not protected`
  and `last = the latest row with a price (reference included), entry = the first TICK row with a price, …`.
- **A late decision.** G4a, the `T/2` deadline is dropped, which is the behaviour of the first push: 88 (83). G4b,
  exactly at `+ T/2` a tick is still decided: 88 (83). Both fail
  `'reference': a tick is decided only before its time + T / 2: a second before it is, at + T / 2 it is missed` (and
  the `'now'` one), `a keeper back only after the tick's time + T / 2: the tick is missed for good, and the next tick catches up by the calendar`,
  `whatever kept a tick from being decided before + T / 2 (a price read that fails, a selection error, a write that fails), it is then missed, not decided late`
  and `in flight for a whole tick: that tick is missed, not decided late`. G4c, a previous tick with no row is
  decided a cycle late: 107 (93). G4d, every missed tick is decided before the current one: 101 (93). Both also fail
  `a missed tick never gets a row, and the next tick treats it as a tick with no prices: cooldown none, last and entry unchanged`
  and `every tick missed but the last: only the current tick is ever decided`. G4e, the previous tick's row stands in
  for a current tick that has none (an old decision executes late): 417 (385), among them
  `a pick is executable until the next tick's time and not after: the next tick decides anew, and the chunk is due again`.
  G4f, a transaction in flight keeps the tick open past `+ T/2`: 1, `in flight for a whole tick: …`.
- **Execute on an unreadable basket.** G5a, an unreadable basket row is used anyway: 1,
  `an unreadable basket row: nothing executes, whatever is wrong with it`. G5b, the status is not looked at (a
  cancelled basket executes): 363 (362), `a basket that is not active executes nothing and is not touched`. G5c, a
  leg order that does not match is used anyway: 1,
  `a leg order that does not match the basket (token, n, owner, chain): nothing executes for the basket`. G5d, an
  unreadable journal row is used anyway: 2, `an unreadable journal: a failed read, a malformed row, a tick twice, a reference row in 'now' mode`
  and `an insert the database does not confirm with the row is a failed write: …`.

The first run of the rig left 3 of 74 mutants alive, and each was a real gap, now closed by a test: the conversion of
`threshold_bps` and of `band_bps` to a double (`× 0.0001` instead of `÷ 10 000` passed every vector: the two differ for
3 241 of the 9 999 values, never for the vectors' own), and the catch-all for an error nobody foresaw. A fourth gap I
found by reading: the fake handed the journal out oldest first, so a coordinator that relied on that order passed; the
fake now returns it newest first and a test shuffles it.

## 5 Verify
`scripts/agent-verify.sh --keeper --codeql` at `caececae` (base `origin/main` `4a4129ef`), with this file and the
evidence file as the only uncommitted changes: **RESULT: PASS**, 8 of 8 (the block as printed: evidence §5).

| Check | Result |
|---|---|
| suite | PASS: 10 845 tests passed, 0 failed, 507 files |
| lint-delta | PASS: errors +0, warnings +0 (2 changed files; head 0 / 0, base 0 / 0) |
| tsc | PASS: 0 errors |
| build | PASS: `next build` ok |
| v1v2-parity | PASS: 123 tests passed, 0 failed, 11 files |
| rpc-budget | PASS: 36 tests passed, 0 failed, 3 files |
| codeql | PASS: security-extended, head 13, base 13, new by rule + file + message 0 |
| keeper | PASS: Node 20 2025 pass / 0 fail / 0 cancelled; Node 22 2025 pass / 0 fail / 0 cancelled |

- `node scripts/gen-claude-state.mjs --check`: "CLAUDE.md state block is current". `node scripts/check-agents-parity.mjs`:
  OK. `--counts`: vitest 507 · keeper node:test 54 · Foundry 3 (the new test file is the keeper's 54th; vitest does not
  pick it up).
- `gitleaks detect --log-opts="origin/main..HEAD"` with the repo's config: no leaks found (after the fix described under
  "Assumption that turned out wrong"; `agent-verify` has no gitleaks check).
- Two earlier full runs also passed 8 of 8: at base `ace16fa7` before PR #705 and the gitleaks fix (suite 10 814 / 0
  in 502 files, keeper 2021 / 0 / 0 twice), and at `6ecbe7cf` on `4a4129ef` for the first push (suite 10 845 / 0,
  keeper 2021 / 0 / 0 twice). The run above, after the owner's deadline, is the one that counts. The mutation rig was
  run on the same final sources: 88 of 88 on both Nodes.
- `git diff --stat origin/main...HEAD`, without these two feedback files: 4 files changed, 3 065 insertions, 0
  deletions (`basket-coordinator.js` 689, `basket-coordinator.test.mjs` 1 849, `schema.sql` 238, the migration 289).
  `git diff --name-only origin/main...HEAD` lists those four and the two feedback files, nothing else.
- Untouched: `executor.js` and every other existing keeper file, the Solidity contracts, `src/` (API and UI),
  `package.json` and the lockfiles. No new dependency. No database was touched.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/split-dca-coordinator
- **Auditor required** (fund-flow: the keeper's decision path and its data model). The owner opens the PR, as Draft.
  No PR was opened and no CI was polled.

## Feedback — commits 2 to 4 and 6 (`814963a4`, `6b7e815a`, `6ecbe7cf`, `caececae`)

### Edge case
- **`stable_leg` is not in spec §5.** The coordinator has to know which leg the peg band applies to (the selection
  module takes `stableLeg`, and the price of that leg comes as a pair), so `baskets.stable_leg` exists. The API goal
  must set it.
- **`keeper_runtime_config.basket_capable` (spec §6) is not in this migration.** The goal scopes the migration to §5
  and the Coordinator rules. The keeper wiring goal needs that column before it can publish the capability.
- **The second slot and the contract's own interval.** The coordinator offers slot 2 from tick time `+ T/2`, as the
  rule says. If slot 1 executed late (say at `+ 0.3 T`), the contract refuses the leg's next chunk until `+ 0.8 T`;
  likewise a slot 2 executed late in tick `t` delays that leg's slot 1 in tick `t + 1`. The wiring must treat "the
  order's `dcaInterval` has not elapsed" as "not yet": no miss, no retry count (ADR-026). That is what the ordinary
  path already does with a `canExecute` refusal (`executor.js:1623-1628`: log, unlock, skip).
- **Nothing off-chain holds a DCA order back today.** The keeper has no due-time gate of its own: it locks every
  active DCA order each cycle and lets the contract's `canExecute` decide (`executor.js:1494`, `:1616-1627`). The
  contract knows nothing about baskets, so a leg order that reaches the lock executes as a plain DCA whenever its
  `dcaInterval` has elapsed (ADR-027 §5, the "old keeper" case). The wiring's journal check therefore has to sit
  before `lockOrder`, as spec §6 says, and until it ships no basket may exist: applying this migration is safe only
  because nothing creates a basket yet.
- **What the `T/2` decision deadline costs (owner's answer 2).** Anything that keeps a tick from being decided for
  the first half of its cycle loses that tick: a keeper outage, price sources that fail, a journal that cannot be
  written, a transaction in flight. That is 12 hours for a daily basket and 3.5 days for a weekly one; the calendar
  and the 2-per-leg limit catch up at the next tick, and the 3 grace ticks are there for it. A decision can still be
  as late as `T/2 - 1` seconds, with the price of that moment. In `'now'` mode a keeper that does not see the basket
  within `T/2` of its creation misses tick 0: the first purchase is then at tick 1, where no leg has a previous
  price, so leg 0 still buys first.
- **A reference row is final.** A leg with no price at first sight has no reference even if the price is back a poll
  later (the spec foresees a leg with no reference price). First sight a moment BEFORE `t0` (clock skew between the
  API and the keeper host) writes the reference: the rule only gives the upper bound. **[superseded by round 2, S-6]**
  within 60 s of `t0` only.
- **A leg order that is cancelled, failed or expired while its basket is active.** The coordinator does not look at an
  order's status beyond `executing`: it keeps deciding, the dead leg stays owed and takes up to two picks per tick that
  cannot execute, the other legs still buy, and the basket ends `expired`, not `completed`. Whether the 8-miss ladder
  may fail one leg of a basket, and what the basket does then, is for the wiring and API goals.
  **[superseded by round 2, S-2]** Such a leg (chunks left, not `active` or `executing`, or its signed expiry come)
  now refuses the whole basket for the poll: no decision, no pick, `leg_not_executable`. What the basket does then
  (cancel it, close it) is still the API's and the wiring's.
- **An execution outside the journal is not flagged.** If a leg's executed count rises by more than its picks of the
  tick, the picks simply count as used. The wiring could alert on it: it would mean a leg order took the ordinary
  path, which spec §6 forbids.
- **The three order rows are needed whatever their status.** `done` is read from them, a completed leg's too.
  `fetchActiveOrders` returns only `active` rows (and at most `MAX_BATCH × 3`), so the wiring needs its own read.
- **`'now'` mode and leg 0.** If leg 0 has no price (or is the stable leg out of band) at the keeper's first poll,
  another leg buys first; the journal says why. The API's check at creation cannot rule this out: the price can go
  between the creation and the first poll.
- **`completed` is written one poll after the last chunk's order row update**, and only from `active`. The leg orders
  get their own `executed` status from the executor as today.

### Assumption that turned out wrong
- **That a reading I disclose stands in for a question.** The goal says "an ambiguous rule: ask once, do not invent".
  I chose four readings, listed them in this file and pushed. The stop check refused the exit; asked, the owner kept
  three and changed one (the decision deadline). The rule with no number in it was the one to ask about before
  building; asking late cost a second code commit, another mutation run and another full verify.
- **The repo copy of the spec and the ADR was older than the pack** when the branch started, and equal to it an hour
  later (PR #704, §1). Other sessions merge to main while a goal runs: a "copy over" step can become a no-op.
- **"RLS like `orders`", copied literally, gives users an INSERT and an UPDATE policy.** `orders` has "Users can
  create own orders" and "Users can cancel own orders". On `baskets` those would be a second way to create a basket,
  past the feed-registry, capability and signature checks of spec §7 and §11, and a way to cancel a basket without its
  three orders. The migration copies the read rule only. If the owner wants the literal three policies, it is two
  statements; say so and I add them.
- **700 bps is not a boundary case.** I first wrote the band conversion test at 7%; `700 × 0.0001` happens to equal
  `0.07`. The test uses 6% (`600 × 0.0001 = 0.060000000000000005`).
- **A green `agent-verify` is not a green CI: it does not run gitleaks.** The first full verify passed 8 of 8 while
  `gitleaks detect --log-opts="origin/main..HEAD"` (8.30.1, the repo's `.gitleaks.toml`) reported 3 findings in the
  migration: its `generic-api-key` rule read `leg0_token_out  TEXT NOT NULL,` and the column name on the next line as
  a credential name and its value (the same for legs 1 and 2). False positives, but the Gitleaks job of the PR would
  have been red. Fixed by the shape of the text, not by an allowlist entry or an inline ignore (an alert is fixed or
  reported, never suppressed): every leg column now has a trailing comment, as the other columns of the table do, and
  `legN_n` follows `legN_token_out`. After the fix: "4 commits scanned … no leaks found"; the same scan with the
  DEFAULT rules on the three files under the allowlisted `contracts/order-engine/` path: 0 findings. Suggestion for
  the harness: a `gitleaks` check in `scripts/agent-verify.sh`.

### Security concern
- **`orders` already has a user INSERT policy** (pre-existing, `contracts/order-engine/schema.sql`). With the new
  column, a row carrying SOMEONE ELSE'S `basket_id` could be inserted by whoever holds a JWT with a `wallet_address`
  claim. Nothing in the repo mints such a token today (the claim appears only in `schema.sql`; the server uses the
  service role), so it is not reachable now. To stay safe if that changes: the wiring should fetch a basket's legs by
  the basket's three `order_hash` values, never by `basket_id` alone; the coordinator refuses anything but exactly three
  rows that carry those hashes and match on basket id, owner, chain, tokens and n (row and signed `order_data`).
- **Nothing an error says reaches a log through this module.** `detail` is built from constants, indexes and field
  names; a caught error contributes its class name only (an RPC URL with a key sat in an error message in
  INC-2026-10-30-001). A price source label must match `^[a-z0-9][a-z0-9:+_.-]{0,63}$`, so a URL cannot be journaled
  and then served by `GET /api/baskets`.
- **A clock in milliseconds would expire every active basket** (every `now` would be past every end). `deps.now()`
  above 99 999 999 999 is refused before anything is written.

### Test gap
- **No test runs the SQL** (§2). The first real execution is the owner's.
- **The fake database is not PostgREST.** The adapter the wiring goal writes must: reject from `insertTick` on any
  non-2xx (`supabaseFetch` in `executor.js` returns the response and does not throw), ask for the stored row
  (`Prefer: return=representation`) and return it, never return a truncated journal from `readTicks`, and make
  `setBasketStatus` conditional on `status = 'active'`. The coordinator already treats "no row back" as a failed write.
- **The float8 and JSONB round trips are argued, not measured**: PostgreSQL 12+ prints a `double precision` as the
  shortest text that reads back to the same double, and JSONB keeps a JSON number as the decimal it was given. The
  wiring goal should write one awkward double (`0.1 + 0.2`) to the live table and read it back before trusting it.
- **`resolvePrice` does not exist yet.** Its contract is in the JSDoc: `(token, { stable })` gives `null` /
  `{ price: null }`, or `{ price, source }` and, for the stable leg, `bandAdd`. Whether a single-source price
  (ADR-024 mode `single`) is a usable DECISION price is not something this module decides.
  **[superseded by round 2, S-3, S-4]** The hint is `{ stable, chainId }`, and each call has a time limit
  (`CALL_TIME_LIMITS_MS.resolvePrice`, 30 s) that the wiring enforces.

### Concern
- **`done` must be true before the coordinator is called.** If the keeper dies between a transaction and the order
  row update, the row undercounts; the coordinator would offer that pick again (the contract refuses it for `T/2`,
  then allows it). The wiring must reconcile an order it finds locked after a restart against the chain, and must
  list as in flight every pick whose outcome is not yet in its order row.
- **Performance: one journal read per active basket per poll** (at most `N + 4` rows, 90 for the longest basket).
  The wiring can read the journals of all active baskets of the chain in one query per cycle and hand each basket
  its rows through `db.readTicks`.

## Round 2 — the fixes for the audit of `6023579a` (goal 117b, 2026-11-17)
Audit of `6023579a` on `origin/main` `4a4129ef`: blocked 0C/3H (S-1 clock, S-2 leg state, S-3 chain), 2 M, 5 L. The
fix per finding is the goal's details file (binding); S-5 is a separate API goal. Run in this session on Opus 5.5.

Checklist:
- [x] Commit 1 `2ae6d2e6`: S-1, S-2, S-3, each with a test named after it that fails on `6023579a` and passes now
- [ ] Commit 2: S-4, S-6, S-7, S-8, S-9, S-10 and the uncovered states; spec copied byte for byte (sha256 pair)
- [ ] Commit 3: seeded property test (four invariants); mutation proof for the three High
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`; `node scripts/gen-claude-state.mjs --check`; keeper suite on Node 20 and 22
- [ ] Push `feat/split-dca-coordinator` (fast-forward, no force), compare link, evidence 1-4
