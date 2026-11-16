# feat/split-dca-coordinator — FEEDBACK (no PR; Draft PR + Auditor required: fund-flow, keeper decision path)

Goal: the Split DCA ("basket") data model and a COORDINATOR module with injected I/O, which turns one basket, its three
order rows and the journal into "the picks executable now". `executor.js` is not changed and nothing calls the
coordinator yet: the keeper behaves as today. Long tables: `feat-split-dca-coordinator.evidence.md`.

Model: CONTROL says Opus; the session runs on Fable 5.2 and the owner's standing answer of 2026-11-16 for
implementation goals is "run here" (asked once on `feat/basket-selection-reference`). Run in-session.

Base: `origin/main` `b47ca15e` (PR #701 merged).

## Checklist
- [ ] Commit 1: spec and ADR-027 copied from the architect pack, byte for byte; this file
- [ ] Commit 2: migration `baskets`, `basket_ticks`, `orders.basket_id` (a file only; no database touched)
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
