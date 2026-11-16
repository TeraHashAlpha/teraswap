# feat/split-dca-coordinator — FEEDBACK (no PR; Draft PR + Auditor required: fund-flow, keeper decision path)

Goal: the Split DCA ("basket") data model and a COORDINATOR module with injected I/O, which turns one basket, its three
order rows and the journal into "the picks executable now". `executor.js` is not changed and nothing calls the
coordinator yet: the keeper behaves as today. Long tables: `feat-split-dca-coordinator.evidence.md`.

Model: CONTROL says Opus; the session runs on Fable 5.2 and the owner's standing answer of 2026-11-16 for
implementation goals is "run here" (asked once on `feat/basket-selection-reference`). Run in-session.

Base: `origin/main` `b47ca15e` (PR #701 merged).

## Checklist
- [x] Commit 1 `43721af8`: spec and ADR-027 copied from the architect pack, byte for byte; this file
- [x] Commit 2: migration `baskets`, `basket_ticks`, `orders.basket_id` (a file only; no database touched)
- [ ] Commit 3: `contracts/order-engine/executor/basket-coordinator.js`
- [ ] Commit 4: tests (node:test, Node 20 and 22), engine vectors replayed through the coordinator, one test per rule
- [ ] Mutation proof in a scratch copy (the goal's five)
- [ ] Verify: `scripts/agent-verify.sh --keeper --codeql`; `node scripts/gen-claude-state.mjs --check`
- [ ] Push `feat/split-dca-coordinator`, compare link

## 1 sha256 pairs (commit 1)
Copied with `cp`, compared with `cmp` (identical) and hashed with `shasum -a 256`:

| File | Architect pack (`~/Desktop/teraswap-architect-pack/basket/`) | Repo copy |
|---|---|---|
| `docs/Prompts/SPEC-BASKET-DCA.md` (18 989 bytes) | `daa33be5bd0f45418b4ebd06955a8f3c0238a42c603a10f47f320264d9d11e0d` | `daa33be5bd0f45418b4ebd06955a8f3c0238a42c603a10f47f320264d9d11e0d` |
| `docs/ADR/ADR-027-basket-dca-three-orders.md` (8 027 bytes) | `26eaa85460036a59cf444bd5e321d34e4842ae556b111c85a16c719e178d65d1` | `26eaa85460036a59cf444bd5e321d34e4842ae556b111c85a16c719e178d65d1` |

Before the copy the repo held `8a3cbc01…c37b` (spec) and `50cb00b1…0e8c` (ADR), the versions of PR #687.

The pack's ADR-027 says `Status: Accepted (owner, 2026-11-13)`; the repo copy said Proposed. `CLAUDE.md`'s generated
state block reads that line, so `node scripts/gen-claude-state.mjs --check` failed after the copy
("Status: Proposed" committed, "Status: Accepted" generated). The block is regenerated in the same commit
(`--write`); `scripts/check-agents-parity.mjs` stays OK (the pin excludes the state block).

## 2 Schema (commit 2)
`supabase/migrations/20261116120000_baskets_split_dca.sql`: two new tables, one new nullable column on `orders`, two
read policies. Every column with its reason: evidence file §2. In short:

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

**The SQL was not run anywhere.** The goal forbids touching a database, and this Mac has no PostgreSQL and no SQL
parser (`psql`, `postgres`: not found; nothing in `node_modules`). What stands in for a run: the file was read
statement by statement against PostgreSQL's rules (three-valued logic in every CHECK over a nullable column, operator
precedence around `IS NULL`, NaN ordering in the price checks), and `basket-coordinator.test.mjs` pins its text: the
column sets against the row the coordinator writes and the rows it reads, DOUBLE PRECISION on the four doubles, no
NUMERIC anywhere, the unique key, the value lists against the code's constants, the only ALTER of an existing table,
and the mirror in `schema.sql`. The owner (or a staging project) is the first to execute it.
