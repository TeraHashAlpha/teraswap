# Feedback — docs/basket-dca-spec-adr-reports (2026-11-13, off origin/main 649105f)

Goal: ADR-027 + spec + analyst package + three dated notes. DOCS ONLY.

- [x] C0 feedback file (this commit)
- [x] C1 ADR-027 + SPEC-BASKET-DCA copied byte-for-byte
- [ ] C2 analyst package → docs/Reports/basket-dca/ — HELD: 40 MB stop AND gitleaks hits (see below)
- [x] C3 three dated notes (ADR-024, FILL-ECONOMICS-CALIBRATION, DEPLOYMENTS) + state block regen (CLAUDE.md, AGENTS.md pin)
- Owner decision (2026-11-13): push the partial branch now; commit 2 waits for a later goal.
- Re-sync: source mtime is 20:47 (owner said 20:50). New sha256, source = copy:
  - ADR-027 `50cb00b11c864bedb535901999c0bedbfddf810aa55d20d8709c955ddfcf0e8c`
  - SPEC `8a3cbc010d81679680063f0bf761a4ee82dc8135c0adebaf26128535f5ffc37b`
  - These replace the first-copy hashes (250930…, 14b6cb…).

## Gitleaks on the source package (not copied): 45 hits, rule `generic-api-key`
- `_inputs/dca-feed-registrations.json` (31) · `data/series/v3/base_feeds.json` (2) · `data/series/v3/executor_registry_base.json` (2) · `data/series/v3/x_feeds.json` (3) · `data/series/v31/executor_registry_base_v31.json` (5) · `results/v3/t4_registry.json` (2)
- Per the goal, a hit is a STOP. Owner to review these files before any copy.

## Premise check
- All three sources exist (`~/Desktop/teraswap-architect-pack/basket/*`, `~/Desktop/Claude/dex-aggregator 2/Analista/basket-dca-v2/docs-Reports-basket-dca/`).
- Highest ADR in docs/ADR/ is 026 → ADR-027 is free.
- origin/main is 649105f (session snapshot said 7e566fd; branch cut from the fetched origin/main).

## Stop: analyst package over 40 MB
- Copy would be 361 files, 220.5 MB total; minus `__pycache__` (2 dirs) and 6 files >5 MB (86.2 MB) ≈ 134 MB still to copy. Above the 40 MB line → commit 2 not made.
- Per top folder (bytes, before exclusions): results/ 122.5 MB · data/ 92.8 MB · charts/ 2.2 MB · src/ 0.8 MB · _inputs/ 0.4 MB · tests/ 0.05 MB · config/ 5 KB · _inputs_v3/ 17 KB.
- Owner decision needed: drop `results/` and `data/` from the copy, or raise the cap, or host the big files outside git.

## Index note
- The ADR index is root `ARCHITECT-INDEX.md` (row per ADR, line 32–33), which is outside `docs/`. Not edited (DOCS ONLY). ADR-027 row to be added by owner or a follow-up.
