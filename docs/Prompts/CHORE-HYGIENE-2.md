# CHORE-HYGIENE-2 — process/CI hygiene batch: template rules, gitleaks allowlist, cuer, stale env files

> **Source:** five small items accumulated 2026-07-09/10, none urgent, all real friction: (1) two agent sessions
> independently reached for the macOS keychain (one nearly self-merged a PR) → the anti-credential rule must live
> in the canonical template + CLAUDE.md, not just in per-goal ad-hoc lines; (2) a stop-hook deadlocked 9 cycles
> because a /goal required "PR open" while PR creation is owner-manual (owner decision 2026-07-10: PRs are opened
> and merged manually, always) → exit-condition wording fix; (3) the gitleaks bare-hex/generic-api-key rules
> false-positived on public constants in 3 PRs (test-fixture WETH/USDC addresses, EIP-712 typehashes, manifest
> JSON); (4) 1 pre-existing red CI test on main: missing `cuer` package; (5) `.env.production`/`.env.local` are
> STALE vs `docs/DEPLOYMENTS.md` (point at FeeCollector V1 + Sepolia executor — documented gotcha).
> Docs/CI/config only, no product logic → **no Auditor gate; Auditor note in the PR body for the gitleaks commit**
> (strictly scoped allowlist, never weakened detection). SSH-signed; branch `chore/hygiene-2` off latest
> `origin/main`, dedicated worktree; 4 droppable commits. **Exit = push + compare link; the owner opens the PR.**

## Requirements (per-commit)

### 1. Template + CLAUDE.md rules (the two process fixes)
- `docs/Prompts/_PROMPT-TEMPLATE.md`: (a) CONTROL header gains, verbatim: **"NEVER invoke credential helpers or
  read the keychain (git credential-*, security find-*) for any purpose; if an action needs auth the session
  lacks, report the manual step and stop."** (b) Expected-output convention gains: **"Exit condition = branch
  pushed + CI green + compare link reported. The OWNER opens and merges PRs — PR creation is never an exit
  condition."**
- `CLAUDE.md`: add both rules to the agent conventions section (agents read CLAUDE.md every session — this is the
  enforcement point), each with a one-line why (keychain near-miss 2026-07-09; stop-hook deadlock 2026-07-09).

### 2. Gitleaks scoped allowlist (closes the recurring false-positive class)
Stop the recurring class WITHOUT weakening secret detection: prefer (a) path-scoped allowlist entries for
known-public-constant locations (`docs/Reports/*.json` manifests, test fixture dirs, `docs/DEPLOYMENTS.md`) and/or
(b) an allowlist regex matching **40-hex checksummed addresses only** (addresses are public by nature). Do NOT
reduce coverage of 64-hex candidates in source code (typehash constants in source keep their existing
narrowly-scoped per-line suppressions — do not generalize those). Each entry commented with the rule + why.
Validate: `gitleaks detect` clean on full history AND a planted fake 64-hex key in a scratch file is still caught
(prove in FEEDBACK, then remove the plant — never commit it).

### 3. Fix the `cuer` red test
Diagnose the pre-existing failure on main (missing `cuer` package): if the dependency is genuinely used, add it
pinned (npm, respect `min-release-age=7d` policy); if the import/test is dead, remove it. State which in FEEDBACK.

### 4. Align stale env files with DEPLOYMENTS.md
`.env.production` / `.env.local` (and `.env.example` if it shares the stale values): update
`NEXT_PUBLIC_FEE_COLLECTOR` → mainnet V2 `0x47f2…7459` (not V1) and `NEXT_PUBLIC_ORDER_EXECUTOR` → the mainnet
executor (not the Sepolia address), **copying the exact strings from `docs/DEPLOYMENTS.md`** (no hand-typed hex,
per the address-hygiene rule). Add a header comment in each file: "Vercel is authoritative; this file mirrors
docs/DEPLOYMENTS.md". No secrets touched — these are public addresses only.

## Do NOT
Touch product/source logic, contracts, keeper, adapters; weaken any gitleaks rule or remove existing suppressions;
add any secret or real key material; touch v3/Arbitrum sprint files; open a PR (owner does).

## Files affected (read ONLY these)
`docs/Prompts/_PROMPT-TEMPLATE.md`, `CLAUDE.md`, `.gitleaks.toml`, the failing `cuer` test file +
`package.json`/lockfile (that dependency only), `.env.production`, `.env.local`, `.env.example`,
`docs/Prompts/CHORE-HYGIENE-2.md` (commit this spec). Read-only: `docs/DEPLOYMENTS.md` (address source),
[[the 3 PRs' gitleaks findings]] via the repo's existing suppressions.

## Expected output
Branch `chore/hygiene-2` pushed, CI green (push + report, don't poll), **compare link reported — do NOT open a
PR.** FEEDBACK ≤1 screen: the two template lines as landed, allowlist entries + the planted-key proof, cuer
verdict (dep-added vs dead-code-removed), env diffs. Auditor note re: gitleaks scope.

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort low · NO CI-poll (push + report, don't watch) · read ONLY the listed files · NEVER invoke credential helpers or read the keychain · FEEDBACK <= 1 screen.

CHORE-HYGIENE-2 per docs/Prompts/CHORE-HYGIENE-2.md (commit the spec in this PR-to-be). Branch chore/hygiene-2 off origin/main in a DEDICATED worktree, SSH-signed, CI green. Docs/CI/config only, no product logic -> no Auditor gate (Auditor note in the eventual PR body for the gitleaks commit). EXIT CONDITION: branch pushed + CI green + report the COMPARE LINK — do NOT open a PR (the owner opens and merges PRs, always).

Commits (droppable, in order):
1. Template + CLAUDE.md rules: (a) docs/Prompts/_PROMPT-TEMPLATE.md CONTROL gains verbatim: "NEVER invoke credential helpers or read the keychain (git credential-*, security find-*) for any purpose; if an action needs auth the session lacks, report the manual step and stop." (b) Same file, Expected-output convention gains: "Exit condition = branch pushed + CI green + compare link reported. The OWNER opens and merges PRs — PR creation is never an exit condition." (c) CLAUDE.md: add both rules to the agent conventions section with a one-line why each (keychain near-miss 2026-07-09; stop-hook deadlock 2026-07-09).
2. Gitleaks scoped allowlist — stop the recurring public-constant false-positive class WITHOUT weakening secret detection: prefer path-scoped allowlist entries (docs/Reports/*.json manifests, test fixture dirs, docs/DEPLOYMENTS.md) and/or an allowlist regex matching 40-hex checksummed ADDRESSES only. Do NOT reduce 64-hex coverage in source (existing per-line typehash suppressions stay as-is, do not generalize). Comment every entry (rule + why). Validate: gitleaks detect clean on full history AND a planted fake 64-hex key in a scratch file is STILL caught — prove in FEEDBACK, remove the plant, never commit it.
3. Fix the pre-existing red test on main (missing `cuer` package): if genuinely used, add pinned dep (npm, respect min-release-age=7d); if the import/test is dead, remove it. State which in FEEDBACK.
4. Align .env.production / .env.local (and .env.example if it shares stale values) with docs/DEPLOYMENTS.md: NEXT_PUBLIC_FEE_COLLECTOR -> mainnet V2 0x47f2…7459 (NOT V1), NEXT_PUBLIC_ORDER_EXECUTOR -> the mainnet executor (NOT Sepolia) — COPY the exact strings from docs/DEPLOYMENTS.md, no hand-typed hex. Header comment in each: "Vercel is authoritative; this file mirrors docs/DEPLOYMENTS.md". Public addresses only, no secrets.

Do NOT: touch product/source logic, contracts, keeper, adapters; weaken any gitleaks rule or remove existing suppressions; add secrets; touch v3/Arbitrum sprint files; open a PR.

Files: docs/Prompts/_PROMPT-TEMPLATE.md, CLAUDE.md, .gitleaks.toml, the failing cuer test + package.json/lockfile (that dep only), .env.production, .env.local, .env.example, docs/Prompts/CHORE-HYGIENE-2.md. Read-only: docs/DEPLOYMENTS.md.

Expected: branch pushed, CI green (push + report), COMPARE LINK in the final report. FEEDBACK <=1 screen: the two template lines as landed, allowlist entries + planted-key proof, cuer verdict, env diffs.
```
