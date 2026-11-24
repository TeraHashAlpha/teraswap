# fix/script-stdout-truncated-on-exit — feedback

## Owner answer (asked once, supersedes the goal text)
Grep found 34 files with a stdout write + `process.exit` (not a handful); the hypothesis itself held (see 1). Owner chose:
fix and test the scripts whose stdout grows with data (can pass a 64 KB pipe); the guard flags every other file unless it is in an
allowlist with a written reason. One commit per script family.

## Checklist
- [x] 1 Reproduction on origin/main (below)
- [ ] 2 check-order-hashes.ts fixed + deterministic repro test
- [ ] 3 other unbounded scripts fixed (one commit per family) + repro tests
- [ ] 4 guard test + allowlist
- [ ] 5 mutation proof
- [ ] 6 agent-verify --keeper --codeql once, result below

## 1. Reproduction (origin/main e0140edd, Node v26.13.1, macOS — NOT Linux)
Reader holds stdout back until the child's stderr summary arrives (its last output before the exit decision), so no sleep and no load.
4,000 rows of `v3-caller-text`: 131,062 bytes / 643 lines delivered of 4,000+ expected (second run 131,470 / 645), every delivered line
valid JSON. The goal's "macOS pipe write is synchronous, never shows locally" is wrong: it reproduces here (kernel pipe + reader
buffer ≈ 128 KB). Linux CI itself was not run.
