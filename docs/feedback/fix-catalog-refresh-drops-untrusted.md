# Feedback — fix/catalog-refresh-drops-untrusted

Goal: the weekly catalog refresh must not die on untrusted tokens (issues #700, #703, #706: 18 tokens, 3 chains).
The guard is untouched; the refresh decides what ships. Tables: `fix-catalog-refresh-drops-untrusted.tables.md`.

## Checklist
- [ ] Step 0: classify the 18 (catalog / list history / bytecode+symbol / 7-day volume); reproduce the 3 failures with the workflow's commands
- [ ] 1-4 pure decision module + tests (real cases, seeded properties, dead upstream, boundaries)
- [ ] build.ts wired to it (PR-body sections, blocked chain changes nothing)
- [ ] 5 issues: close on pass, never a second open issue per chain
- [ ] workflow diff
- [ ] guard test file diff empty; mutation proof; verify once (load < 10)
- [ ] push, compare link

(Evidence 1-5 are written below as they land.)
