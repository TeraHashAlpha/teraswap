# CHORE-GROK-DENY-RULES — tool-level `.env*` deny rules + macOS bash 3.2 compatibility rule

> **Source/Context:** Follow-up to PR `chore/grok-dispatch` (`b7cb4af`, `3a590e0`, merged as PR #431). Two
> gaps left open there: (a) nothing at the tool level stops a Grok run from reading this repo's `.env*` files
> — the `AGENTS.md` prose is documentation, not enforcement; (b) macOS ships bash 3.2.57, and both `bash` and
> `/usr/bin/env bash` resolve to it, so bash-4-only syntax in any repo `.sh` breaks locally. Not fund-flow →
> **no Auditor gate**, but the deny-rule gap is security-relevant and rides the next security review.
> SSH-signed noreply committer, dedicated worktree off `origin/main`. **3 droppable commits.**

## Requirements

### Commit 1 — tool-level deny rules

1. Add project-scope `.grok/config.toml` with permission rules denying reads of `.env*` and any keychain /
   credential-helper invocation — **verified against `grok --help` and the shipped `~/.grok/README.md` first.**
2. Prove the file is tracked (`git check-ignore -v` + `git ls-tree`), not silently ignored, as
   `scripts/*.sh` was in the previous PR.
3. Do not run `grok` to test this — put the one manual verification command in
   `docs/feedback/<branch>.md` instead.

**Finding:** requirement 1 as literally stated is not achievable. Grok Build 1.0.5's project-scoped
`.grok/config.toml` supports only `[mcp_servers]` (verbatim from its own README); there is no `[permissions]`
TOML table anywhere, project or global — permission rules exist exclusively as `--allow`/`--deny` CLI flags.
`.grok/config.toml` was written with a `TODO(security)` documenting this, the verified `Read(.env*)` /
`Bash(...)` CLI-flag syntax for a future dispatcher wiring, and an explicit note that adding a fake
`[permissions]` table would be worse than no file (silent no-op mistaken for enforcement).

### Commit 2 — bash 3.2 compatibility rule

4. Add the bash-3.2-compatibility rule to `CLAUDE.md` (`## Conventions`) and mirror it verbatim into
   `AGENTS.md`'s hard-rules section.
5. `scripts/check-bash3-compat.mjs`: scan every tracked `.sh` for bash4-only constructs
   (`${var,,}`/`${var^^}`, `declare -A`, `mapfile`/`readarray`, `shopt -s globstar`), fail with `file:line`.
   Strip comments before matching.
6. Tests with positive and negative controls per construct, plus the required regression case: a comment
   merely mentioning `${var,,}` must not fail, and the real `scripts/grok-dispatch.sh` (which has exactly
   that comment) must pass.
7. Wire into `package.json`, the CI `lint` job, and `vitest.config.ts` (already covered `scripts/*.test.mjs`
   from PR #431 — no change needed there).

### Commit 3 — re-pin the parity hash

8. `node scripts/check-agents-parity.mjs --write` after the `CLAUDE.md` edit, review the `AGENTS.md` diff,
   commit the recomputed sha (never hand-typed), with a length sentinel in the feedback file.

## Do NOT

- Install or run Grok Build, or call the xAI API.
- Read or print any `.env*` file, keychain entry, or credential-helper output.
- Touch `contracts/`, `keeper/`, `src/lib/chains/`, or any swap/gate path.
- Invent Grok config keys.
- Hand-type any sha.
- Widen scope beyond the files listed below.

## Files affected (read ONLY these)

- `.grok/config.toml` (new)
- `.gitignore` (only if a tracking exception is needed — it wasn't)
- `CLAUDE.md`
- `AGENTS.md`
- `scripts/check-bash3-compat.mjs` (new), `scripts/check-bash3-compat.test.mjs` (new)
- `scripts/check-agents-parity.mjs` (read-only — run it, don't edit it)
- `scripts/grok-dispatch.sh` (read-only — it is a test fixture)
- `package.json`, `vitest.config.ts`, `.github/workflows/ci.yml`
- `docs/Prompts/CHORE-GROK-DENY-RULES.md` (this file), `docs/feedback/<branch>.md`

## Expected output

Branch `chore/grok-deny-rules` off up-to-date `origin/main` (PR #431 already merged) in a dedicated worktree.
SSH-signed noreply committer. Push + report — do not poll CI. Full suite green, both new checks green,
`bash -n` + shellcheck unchanged on `grok-dispatch.sh`.

## Quality criteria

- The comment-vs-code distinction is covered by a test, not by inspection.
- `.grok/config.toml` is proven tracked by `git ls-tree`, not assumed.
- The re-pinned sha is computed by the script and carries a length sentinel.
- The PR body states plainly, in one line, that the Grok permission-rule syntax could not be honored as a
  config.toml key because no such key exists.

---

### `/goal` paste for the Code Agent

```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the Files affected list above · FEEDBACK <= 1 screen.

Follow-up to PR chore/grok-dispatch (b7cb4af, 3a590e0, merged as #431). See docs/Prompts/CHORE-GROK-DENY-RULES.md for the full spec (this file). Implement commit 1 (.grok/config.toml + tracking proof + feedback), commit 2 (bash-3.2 rule + checker + tests + CI wiring), commit 3 (re-pin parity hash) as described there.
```
