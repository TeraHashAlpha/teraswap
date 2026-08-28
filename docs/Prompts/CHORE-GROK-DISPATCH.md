# CHORE-GROK-DISPATCH — AGENTS.md parity + guarded Grok Build dispatcher

> **Source:** owner `/goal`, 2026-08-28. Docs/tooling only — no fund-flow logic changed. **No Auditor gate**
> (the refusal list below is gate-adjacent and rides the next security review, per the owner's note). SSH-signed,
> noreply committer. Branch `chore/grok-dispatch` off `origin/main` in a dedicated worktree. 2 droppable commits.

## Context

Grok Build (xAI's coding-agent CLI) becomes a second Code Agent; Claude stays Architect/Auditor. Grok reads
`AGENTS.md`, not `CLAUDE.md`, so none of the hard rules in `CLAUDE.md` reach it unless they're inlined
somewhere Grok actually reads. This chore adds that parity file plus a guarded dispatcher — it does **not**
install, run, or configure Grok Build, and never calls the xAI API.

## Requirements

### Commit 1 — AGENTS.md parity

1. `AGENTS.md` at repo root: role split (coding agent never audits its own work, never deploys, never merges
   a fund-flow PR), pointers to `docs/Prompts/_PROMPT-TEMPLATE.md` and `docs/security/AUDIT-TOTAL.md`,
   `CLAUDE.md` named as the normative source.
2. Inline verbatim: address hygiene, credential hygiene, chain-awareness-as-root-cause, dependency/deletion
   policy — a pointer to `CLAUDE.md` is not enough since Grok never reads it.
3. `scripts/check-agents-parity.mjs`: recomputes sha256 of `CLAUDE.md`, compares against the
   `<!-- claude-md-sha256: ... -->` line pinned in `AGENTS.md`, fails on mismatch printing expected, actual,
   and a length sentinel for both. `--write` regenerates the pin (never hand-typed). Wired into CI's `lint`
   job via `npm run check:agents-parity`.

### Commit 2 — guarded dispatcher

4. `scripts/grok-dispatch.sh <spec> <branch> [--dry-run] [--execute]`.
5. `--dry-run` is the default and never invokes `grok`; a real run needs explicit `--execute`. Refuses unless
   the spec's `/goal` has a `CONTROL:` header with explicit `model` and `effort`. Resolves the Grok model from
   one table (`low→grok-build-0.1`, `medium→grok-4.5`, `high→grok-4.6`). Always works in a fresh
   `git worktree add … origin/main`. Drops `--always-approve` (runs interactive) when effort is `high` or
   "Files affected" matches `contracts/**`, `keeper/**`, `*executor*`, `src/lib/chains/**`, or a swap/gate/
   signer path. Refuses outright when "Files affected" names a `.env*` path or a keychain/credential
   reference. Writes the run's JSON + a summary to `docs/feedback/<branch>.md`; never polls CI.
6. "Dispatching to Grok Build" section added to `docs/Prompts/_PROMPT-TEMPLATE.md` (§7): dispatcher is the
   only sanctioned entry point, `--execute` is always a human decision.

## Do NOT

- Install or run Grok Build, or call the xAI API, at any point in this chore.
- Read or print any `.env*` file, keychain, or credential-helper output.
- Touch `contracts/`, `keeper/`, `src/lib/chains/`, or any swap/gate/signer path.
- Make `--always-approve` the dispatcher's default.
- Hand-type any hash — the parity script computes and writes its own.
- Modify `CLAUDE.md`.

## Files affected (read ONLY these)

- `AGENTS.md` (new)
- `scripts/check-agents-parity.mjs` (new)
- `scripts/check-agents-parity.test.mjs` (new)
- `scripts/grok-dispatch.sh` (new)
- `scripts/grok-dispatch.test.mjs` (new)
- `package.json`
- `vitest.config.ts`
- `.github/workflows/ci.yml`
- `docs/Prompts/_PROMPT-TEMPLATE.md`
- `docs/Prompts/CHORE-GROK-DISPATCH.md` (this file)

## Expected output

Branch pushed, compare link reported, local verification done (parity check green, dispatcher unit tests
green, `bash -n` + shellcheck clean). CI runs once the owner opens the PR — PR creation is never the agent's
job. Do not watch CI after pushing.

## Quality criteria

- A unit test for every dispatcher refusal path, each with a positive AND a negative control; none of them
  reach a passing `--execute` path (no test may actually invoke `grok`).
- `bash -n scripts/grok-dispatch.sh` and `shellcheck scripts/grok-dispatch.sh` clean.
- `node scripts/check-agents-parity.mjs` green against the committed `CLAUDE.md`/`AGENTS.md` pair.
- Full `npm test` suite still green (no regressions from the new vitest include glob).

---

### `/goal` paste for the Code Agent

```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY <the Files affected list above> · FEEDBACK <= 1 screen.

Grok Build (xAI's coding-agent CLI) becomes a second Code Agent; Claude stays Architect/Auditor. Grok reads AGENTS.md, not CLAUDE.md, so none of our hard rules reach it. Add those rules + a guarded dispatcher ONLY — do NOT install Grok, run it, or call the xAI API.

See docs/Prompts/CHORE-GROK-DISPATCH.md for the full spec (this file). Implement commit 1 (AGENTS.md + scripts/check-agents-parity.mjs + CI wiring) and commit 2 (scripts/grok-dispatch.sh + tests + _PROMPT-TEMPLATE.md §7) as described there.
```
