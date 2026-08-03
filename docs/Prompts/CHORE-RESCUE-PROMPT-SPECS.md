# CHORE-RESCUE-PROMPT-SPECS — commit the Architect prompt library + T-SAF framework to main (docs-only)

> **Source:** the post-P0 git cleanup (2026-07-06) revealed that **~44 `docs/Prompts/*.md` Architect specs + the T-SAF
> source-of-truth `docs/security/TERASWAP-AUDIT-FRAMEWORK.md` exist ONLY on the local dead-branch snapshot
> `docs/inc-2026-06-09` (commit `315d3bc`)** — written to the working copy, never committed to `main`. Single-disk risk
> + the framework that governs the whole T-SAF campaign is absent from `main`. **Docs-only rescue. No source/code/config,
> no contract, no behaviour change.** SSH-signed (noreply committer).

## Objective
Bring exactly the `docs/Prompts` specs + the framework doc that are **missing from `origin/main`** onto a signed docs
PR — without overwriting the specs `main` already has (those are the Code-Agent-committed versions).

## Requirements
1. **Enumerate the rescue set precisely** — files ADDED (present on the snapshot, absent from main):
   `git diff --name-status --diff-filter=A origin/main docs/inc-2026-06-09 -- docs/Prompts/` (≈44 files), PLUS
   `docs/security/TERASWAP-AUDIT-FRAMEWORK.md` if `git cat-file -e origin/main:docs/security/TERASWAP-AUDIT-FRAMEWORK.md`
   fails. List the exact set in FEEDBACK.
2. **Bring them in from the local snapshot:** branch off latest `origin/main`, then
   `git checkout docs/inc-2026-06-09 -- <each missing file>`. **Do NOT touch the ~10 `docs/Prompts` files that already
   exist on main with different content** (the `M` set — main's versions are the implemented/committed ones; leave
   them). If any `M` file's snapshot version looks like it has content main lacks, **report it in FEEDBACK** — do not
   overwrite.
3. **Secret-scan the rescued files** before commit (gitleaks + the repo `.gitleaks.toml`). Prompt specs may contain
   example on-chain addresses (fine) — but **exclude + flag** anything that scans as a real secret; do not commit it.
4. **Commit SSH-signed (noreply), docs-only, open a PR, CI green.** One commit (or a few logical ones) — these are
   inert docs.
5. **If the local ref `docs/inc-2026-06-09` is NOT visible** in your worktree (it's the owner's local snapshot, not
   pushed), **STOP and report** — do NOT reconstruct any file from memory.

## Do NOT
- Don't overwrite `main`'s existing `docs/Prompts` versions. Don't bring any source/code/config from the dead branch
  (docs only — no `src/`, no `contracts/`, no `.json`/lockfiles). Don't delete the dead branch (rule #4). Don't commit
  a secret-bearing file.

## Files affected
- `docs/Prompts/*.md` (the ~44 absent-from-main specs) + `docs/security/TERASWAP-AUDIT-FRAMEWORK.md`, sourced from
  `docs/inc-2026-06-09` (`315d3bc`).

## Expected output
- Branch `chore/rescue-prompt-specs` off latest `origin/main`; SSH-signed; CI green; the ~45 files committed. FEEDBACK:
  the exact rescued list, any excluded/flagged file, any `M`-file nuance, and the **process fix** — going forward the
  Architect's prompt spec should be committed as part of each implementation PR (or a periodic docs commit) so specs
  never live single-disk again.

## Quality criteria
The Architect prompt library + the T-SAF framework are on `main` (no longer single-disk); `main`'s existing spec
versions are untouched; no source/secret committed; the dead branch is preserved; CI green.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-RESCUE-PROMPT-SPECS per docs/Prompts/CHORE-RESCUE-PROMPT-SPECS.md. Branch
chore/rescue-prompt-specs off latest origin/main, SSH-signed (noreply committer),
CI green. DOCS-ONLY — no source/code/config/contract, no behaviour change.

Why: the post-P0 git cleanup found ~44 docs/Prompts/*.md Architect specs + the
T-SAF source-of-truth docs/security/TERASWAP-AUDIT-FRAMEWORK.md exist ONLY on the
local dead-branch snapshot docs/inc-2026-06-09 (commit 315d3bc) — never committed
to main. Rescue them (single-disk risk).

Do:
1. Enumerate the rescue set: git diff --name-status --diff-filter=A origin/main
   docs/inc-2026-06-09 -- docs/Prompts/ (~44 files) PLUS
   docs/security/TERASWAP-AUDIT-FRAMEWORK.md if absent from main
   (git cat-file -e origin/main:<that path> fails). List them in FEEDBACK.
2. Bring them in: branch off latest origin/main, then `git checkout
   docs/inc-2026-06-09 -- <each missing file>`. Do NOT touch the ~10 docs/Prompts
   files already on main with different content (the M set — main's are the
   committed/implemented versions; leave them). If any M snapshot version seems to
   have content main lacks, REPORT it, don't overwrite.
3. Secret-scan the rescued files (gitleaks + .gitleaks.toml). Example on-chain
   addresses are fine; EXCLUDE + flag anything that scans as a real secret.
4. Commit SSH-signed, docs-only, open a PR, CI green.
5. If the local ref docs/inc-2026-06-09 is NOT visible in your worktree (owner's
   snapshot, not pushed), STOP and report — do NOT reconstruct any file from memory.

Do NOT: overwrite main's existing docs/Prompts versions; bring any source/code/
config from the dead branch (docs only); delete the dead branch (rule #4); commit
a secret-bearing file.

Deliver: the PR + FEEDBACK with the exact rescued list, any excluded/flagged file,
any M-file nuance, and the process fix (commit the spec as part of each
implementation PR going forward so specs never live single-disk again).
```
