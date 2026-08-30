# CHORE-COLOR-CONTRAST-CHECK — CVD regression check for the status palette

> **Source:** measured defect 2026-08-29. Display only — **no Auditor gate** (no fund-flow).
> SSH-signed, noreply committer. Branch `chore/color-contrast-check` off `origin/main` in a
> dedicated worktree. 3 droppable commits.

CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the files listed below · FEEDBACK <= 1 screen.

## Context

The status palette in `tailwind.config.ts` (`success` `#4ADE80`, `warning` `#F59E0B`,
`danger` `#EF4444`) separates well for normal vision (dE2000 34–77) but collapses under
colour-vision deficiency:

- deuteranopia: success/warning and warning/danger under the 15 floor
- protanopia: success/warning under the floor

Roughly 6% of men are deuteranope. On a DEX these three colours carry "safe / degraded /
blocked", so this is a functional defect, not a cosmetic one. Normal vision passes
comfortably, which is why nobody saw it.

**Do not change the palette** — brand colours are the owner's decision. Build the
regression check and the evidence.

## Requirements

### Commit 1 — checker + proof tests

1. `scripts/check-color-contrast.mjs` — parse `success` / `warning` / `danger` hex out of
   `tailwind.config.ts` (never hard-code the hex; if the palette moves, the check must
   follow it or fail loudly). Compute CIEDE2000 for every pair under normal vision,
   deuteranopia and protanopia (Viénot / Brettel / Mollon 1999 linear-RGB approximations).
   Fail any pair below dE2000 15.
2. PROVE the maths, do not assert it. Required test: Sharma et al. reference pair
   Lab(50.0000, 2.6772, −79.7751) vs Lab(50.0000, 0.0000, −82.7485) must give dE00 = 2.0425
   within 1e-4. A dE76 implementation returns ~4.0 and MUST fail this test. Also assert
   identical colours give 0, and that the CVD simulator leaves a neutral grey unchanged.
3. Mutation test: the checker FAILS when fed a deliberately colliding unbaselined pair
   (prove the assertion bites). Parser fails loudly if the three keys cannot be read.
   Tests import/drive the shipped functions — no parallel copy, no mock of the math.

### Commit 2 — baseline + wiring

4. Record currently-failing pairs in an explicit, commented baseline so CI stays green
   today — but ANY new failing pair breaks the build, AND any baseline entry that starts
   passing also breaks it, so the baseline cannot rot. Never widen the baseline to silence
   a new failure. (CHORE-HYGIENE-1 pending-baseline precedent: known state is labelled,
   novel faults still fail closed.)
5. Wire into `package.json` (`check:color-contrast`), the CI `lint` job (next to
   `check:agents-parity` / `check:bash3-compat`), and `vitest.config.ts`. Those three
   wiring files only.

### Commit 3 — evidence + spec

6. `docs/design/STATUS-COLOR-CVD-2026-08-29.md` — the measured table (3 conditions × 3
   pairs) from the shipped check, the method, the Sharma reference vector, and the honest
   limit: colour separation is a backstop, not accessibility. The actual guarantee is the
   standing rule that colour is ALWAYS paired with an icon and a label and never carries
   meaning alone. Propose candidate replacement hex values that clear 15 in all three
   conditions, clearly marked as PROPOSALS awaiting the owner. Do not apply them anywhere.
7. Commit this spec in the same PR.

## Do NOT

- Change any value in `tailwind.config.ts` or any brand colour anywhere in the repo.
- Hard-code the palette inside the checker.
- Ship dE76 as if it were dE2000.
- Widen the baseline to silence a new failure.
- Touch `contracts/`, `keeper/`, `src/lib/chains/` or any swap-gate path.
- Claim anywhere that this check makes the UI accessible.
- Apply the proposed replacement hex anywhere.
- Add a colour-science npm dependency.
- Open a GitHub PR or watch CI.
- Auditor gate (display only, no fund-flow).

## Files affected (read ONLY these)

- `scripts/check-color-contrast.mjs` (new)
- `scripts/check-color-contrast.test.mjs` (new)
- `tailwind.config.ts` (read `success` / `warning` / `danger`; do not edit)
- `docs/design/STATUS-COLOR-CVD-2026-08-29.md` (new)
- `docs/Prompts/CHORE-COLOR-CONTRAST-CHECK.md` (this file)
- `package.json`
- `.github/workflows/ci.yml` (lint job)
- `vitest.config.ts`

## Expected output

Branch `chore/color-contrast-check` pushed, compare link reported, local verification
done. 3 SSH-signed noreply commits (`TeraHash <256859133+TeraHashAlpha@users.noreply.github.com>`).
CI runs once the OWNER opens the PR and must be green before merge — PR creation is never
the agent's job. Do not watch CI after pushing.

The text prepared for the PR body must state plainly that **the palette is UNCHANGED**
and the replacement colours await the owner's decision.

## Quality criteria

- Full suite green.
- Sharma reference-vector test present and passing (imports the shipped `ciede2000`).
- Mutation test proves the checker FAILS on a colliding unbaselined pair.
- Live `node scripts/check-color-contrast.mjs` exits 0, names the known under-15 pairs
  as baselined, reports no unbaselined failure. Two consecutive runs emit the same
  classification (deterministic).
- `git diff origin/main -- tailwind.config.ts` is empty.
- Nowhere claims this check makes the UI accessible.

---

### `/goal` paste for the Code Agent

```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY scripts/check-color-contrast.mjs, scripts/check-color-contrast.test.mjs, tailwind.config.ts, docs/design/STATUS-COLOR-CVD-2026-08-29.md, docs/Prompts/CHORE-COLOR-CONTRAST-CHECK.md, package.json, .github/workflows/ci.yml, vitest.config.ts · FEEDBACK <= 1 screen.

MEASURED DEFECT, 2026-08-29. Status palette (success #4ADE80, warning #F59E0B, danger #EF4444) collapses under CVD (deut success/warning and warning/danger, prot success/warning all dE2000 < 15). Build the regression check and the evidence. DO NOT change the palette.

Branch chore/color-contrast-check off origin/main in a dedicated worktree. SSH-signed noreply committer. 3 droppable commits.

1. scripts/check-color-contrast.mjs — parse status colours from tailwind.config.ts (never hard-code hex). CIEDE2000 for every pair under normal / deuteranopia / protanopia (Viénot/Brettel/Mollon 1999). Fail any pair below dE2000 15.
2. Prove the maths: Sharma Lab(50.0000, 2.6772, -79.7751) vs Lab(50.0000, 0.0000, -82.7485) → dE00 = 2.0425 ± 1e-4. Identical colours → 0. Neutral grey unchanged under CVD. Mutation: colliding unbaselined pair fails the checker.
3. Explicit commented baseline of currently-failing pairs (CI green today). New fail breaks; baseline-now-passing breaks. Never widen.
4. docs/design/STATUS-COLOR-CVD-2026-08-29.md — 3×3 table, method, Sharma vector, honest limit (colour always paired with icon+label; this check is not accessibility). Candidate replacement hex marked PROPOSALS, not applied.
5. Wire package.json, CI lint job, vitest.config.ts. Those three only.

DO NOT: change tailwind.config.ts or any brand colour; hard-code the palette; ship dE76 as dE2000; widen the baseline; touch contracts/, keeper/, src/lib/chains/ or swap-gate; claim the check makes the UI accessible.

TESTS: full suite green; Sharma test present and passing; mutation test bites.
OUTPUT: push + report, do NOT watch CI. Commit this spec. No Auditor. PR body: palette UNCHANGED; replacements await the owner.
```
