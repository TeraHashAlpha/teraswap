# chore/harness-housekeeping-2026-11 — FEEDBACK (no PR; owner opens it)
Base: origin/main 22179224 (PR #691). Own worktree `~/ts-worktrees/harness-housekeeping`, real `npm ci`. Long tables, if any, go to `chore-harness-housekeeping-2026-11.evidence.md`.

## Checklist
- [x] Commit 0: this file
- [x] Commit 1: AGENTS.md pin hashes CLAUDE.md without the generated state block
- [x] Commit 2: agent-verify `--keeper` fake-install tests isolated from the real machine
- [x] Commit 3: agent-verify and the runbook never tell an agent to install Node
- [x] Commit 4: audit allow-list, zod renewed to 2026-12-22, uuid reachability measured
- [x] Verify: `scripts/agent-verify.sh --codeql`, `gen-claude-state.mjs --check`, `check-agents-parity.mjs`, `audit-gate.mjs`
- [x] Push (literal branch name, no force), compare link

## Premise differences found while reading
- `docs/feedback/chore-dependabot-alerts-2026-11.md` and its `.evidence.md` are NOT on origin/main; they live only on `origin/chore/dependabot-alerts-2026-11` (read with `git show`). Section "Allowlist proposals" there is the source for commit 4.
- The generated block (`<!-- state:begin -->` .. `<!-- state:end -->`, CLAUDE.md lines 155-179) is built from contracts (DEPLOYMENTS.md), workflow names, ADR files and test-runner commands (`gen-claude-state.mjs:6-18`). It does not read runbooks, and test counts were already removed from it. "ADR, workflow or contract added" is the accurate trigger, not "runbook".
- Cause of the four tests (read, to be reproduced in commit 2): `find_node_major` (`agent-verify.sh:209-222`) also tries the absolute `/opt/homebrew/opt/node@N/bin/node` and `/usr/local/opt/node@N/bin/node`, which the test's fake `HOME`/`PATH` cannot hide. The default Node being v26 is not the cause; installed brew `node@20`/`node@22` is. The Dependabot branch's "Verify closure" reached the same reading with `sandbox-exec`.

## Evidence 1: the pin (commit 1)
- `scripts/check-agents-parity.mjs` now hashes CLAUDE.md with `<!-- state:begin -->` .. `<!-- state:end -->` (markers included) cut out. Pin re-written once: `f43d7e84…0f06` -> `faa4b681…5b7e` (AGENTS.md line 1). AGENTS.md "Drift guard" paragraph and the script header say so.
- Tests (`scripts/check-agents-parity.test.mjs`, 16, all pass; 13 of them fail against the old script, mutation-checked by restoring it): positive and negative control; missing pin line; `--write` round trip; a rule edit BEFORE and AFTER the block fails; a regenerated block with other content passes; an empty block passes and the hash equals the hash of the file with the span removed; 7 marker faults (missing begin, missing end, both missing, duplicated begin, duplicated end, duplicated block, reversed) each exit 1 in check AND in `--write`, with `--write` leaving AGENTS.md untouched; the script's markers equal the `BEGIN`/`END` exported by `gen-claude-state.mjs`; a dry run on the real CLAUDE.md.
- Dry run on the real CLAUDE.md (scratch dir, nothing in the repo touched): block replaced with `| regenerated | with other content, a new ADR, a new workflow |`, same AGENTS.md -> `AGENTS.md parity OK: faa4b681…5b7e (len=64)`, exit 0. Editing `NEVER hardcode secrets` outside the block -> exit 1 (test above).
- Decision: a rule hand-written INSIDE the markers is excluded from the pin, but `gen-claude-state.mjs --check` (CI `lint` job) fails on any difference from the generated block, so it cannot land.
- Left alone on purpose: the generated block itself (CLAUDE.md:157, `gen-claude-state.mjs:181`, its test fixture) still says to run `check-agents-parity.mjs --write` after `--write`. It is now a harmless no-op for a block-only change; changing it edits generated text and `gen-claude-state.mjs`, which is outside this goal. Suggest dropping it in the next change that regenerates the block.

## Evidence 2: the four tests (commit 2)
- **Reproduced** on the default Node v26.13.1 before the fix: `vitest run scripts/agent-verify.test.mjs -t "agent-verify --keeper"` -> 4 failed, 30 skipped. The failing line: `keeper FAIL node20:0-pass/0-fail/0-cancelled node22:0-pass/0-fail/0-cancelled` where the test expected `node20:MISSING` or `PASS`.
- **Cause (not the active Node):** `find_node_major` (`agent-verify.sh:209-222`) lists `/opt/homebrew/opt/node@N/bin/node` and `/usr/local/opt/node@N/bin/node` as absolute candidates. The test's fake `HOME`, `PATH` and `NVM_DIR` hide nvm, fnm, volta and `brew` itself but cannot hide an absolute path. This Mac has `/opt/homebrew/opt/node@20` and `@22` since the 2026-11-14 brew install, so every "fake install" run found the REAL Node 20/22 and ran `node --test` in an empty fake repo (0 tests). They pass in CI because the runner has no Homebrew. The default Node being v26 is incidental.
- **Fix (test only; `agent-verify.sh` lookup untouched):** `keeper()` re-roots those two prefixes under the fake home (`<home>/abs/opt/homebrew/opt/...`) in ITS OWN COPY of the function text, and `expect`s that both prefixes are still in the script, so it fails loudly instead of silently reading the machine again if the script stops listing them. New test: the two absolute prefixes still work as candidates (fake nodes placed there are found) and with no fake install both majors are MISSING whatever the real machine has. No existing assertion changed.
- **Results** (`scripts/agent-verify.test.mjs`): default Node v26.13.1: 35 passed, 0 failed; Node v22.23.5 (`/opt/homebrew/opt/node@22/bin` first on PATH, nothing installed): 35 passed, 0 failed. With the isolation made a no-op: 5 failed (the 4 plus the new test), so the new test is real. After commit 3 the file has 36 tests; both Nodes: 36 passed.
- Not changed: a `brew` binary in `/usr/bin` would still be consulted by the real function; the test PATH is `<fake>/bin:/usr/bin:/bin`, where there is none, on macOS and on the CI runner.

## Evidence 3: the new message (commit 3)
```
keeper	FAIL	node20:MISSING node22:MISSING — not substituting another version. Missing Node major(s): 20, 22; ask the owner to install them; do not install anything yourself
```
Printed by the real `check_keeper` against a fake repo; with only Node 20 missing it reads `Missing Node major(s): 20;`. Old: `… install: brew install node@20 node@22`. Pinned by two tests: the wording for one and for two missing majors (a found major is not listed), no `brew|install:|install node|npm i|nvm install|fnm install|volta install` anywhere in the line, and no `brew install|upgrade|reinstall` anywhere in the script source (`brew --prefix` in the lookup stays). `docs/Runbooks/agent-harness.md` "Verify and audit" has the same rule plus the 2026-11-14 account. Other `brew install` mentions in the repo: `docs/Runbooks/SIGNED-COMMITS.md:77` (`gnupg pinentry-mac`, an owner setup step, not Node, left alone); the one in the hooks folder is a comment, and I did not touch that folder.

## Evidence 4: allow-list, gates, verify (commit 4)
Diff of `audit-allowlist.json` (2 entries touched, nothing else, gate script untouched):
- zod `GHSA-mrhx-c7xc-m3w5`: `expires` 2026-11-22 -> 2026-12-22; `reason` replaced: renewed 2026-11-16 by owner decision; two vulnerable copies (3.25.76 under @coinbase/cdp-sdk, 3.22.4 under @reown/appkit-wallet) in neither the browser output (258 chunks) nor the server output, not traced into a Vercel function; 3.22.4 has no `handleArrayResult`, 3.25.76 has it only in its `v4` subtree and cdp-sdk imports bare `"zod"` (the v3 API); the only fix is zod 4.6.6 via a parent major (wagmi 3), which the repo forbids.
- uuid `GHSA-w5hq-g745-h8pq`: "Reachability in the app is NOT yet verified (grep ... before renewal)" -> measured: the three copies are called only as `v4()` and `validate()`, 0 references to v3/v5/v6, the bundled MetaMask chunk has no v3/v5 code.
- Source of both measurements: `docs/feedback/chore-dependabot-alerts-2026-11.md` and its `.evidence.md` (section C), which exist only on `origin/chore/dependabot-alerts-2026-11` today; the `reason` text cites the evidence path, which resolves once that branch is merged.

Header rule: the file's `$comment` says an entry is "ONLY justified when a fix exists but is currently un-installable under min-release-age=7". The zod entry is not that case (its fix is a parent major, not an age wait), so the header forbids it. Applied anyway per the owner decision, as instructed. The same is true of the minimatch, glob and uuid entries from 2026-11-06. Suggest the owner amends the header to name "fix is a parent major the repo forbids" as a second admissible reason, or the next renewal will conflict with its own text.

`node scripts/audit-gate.mjs` (exit 0): `1 high/critical advisory present, 1 allowlisted, 0 blocking. ALLOWLISTED HIGH zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), expires 2026-12-22`. It also prints five `RESOLVED ... no longer appears in npm audit — delete this allowlist entry` lines (minimatch, glob, uuid, elliptic, deepmerge). Those are moderate/low advisories, which the gate never lists (it reads high/critical only), so the "delete this entry" advice is misleading and I did NOT delete them ("no other entry changes"). Worth a gate fix later.

Other gates: `node scripts/gen-claude-state.mjs --check` -> `CLAUDE.md state block is current`; `node scripts/check-agents-parity.mjs` -> `AGENTS.md parity OK: faa4b681…5b7e (len=64)`.

`scripts/agent-verify.sh --codeql` at 080b157d (base origin/main 0a797163, which moved by PR #692 after I branched at 22179224; `git merge-tree` shows a clean merge, #692 touches none of CLAUDE.md, AGENTS.md or these scripts):
```
suite:       PASS 10814 tests passed, 0 failed, 502 files
lint-delta:  PASS errors +0, warnings +0 (3 changed files)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 123 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      SKIP not requested (--keeper)
RESULT: PASS
```
The suite is green on this Mac with brew node@20/22 installed, i.e. the four old failures are gone without hiding anything.
diff --stat origin/main...HEAD (before this final feedback edit): 8 files, 205 insertions, 51 deletions (AGENTS.md, audit-allowlist.json, agent-harness.md runbook, agent-verify.sh +2/-2, agent-verify.test.mjs, check-agents-parity.mjs, its test, this file).
Not run: `--keeper` (not requested; this goal changed only its message and test isolation, and it does not install anything). Nothing installed or upgraded on the machine; `brew` never run; the harness settings and hooks were not touched; no CI polling.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/harness-housekeeping-2026-11
