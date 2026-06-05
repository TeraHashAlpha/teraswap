# CHORE — Docs housekeeping: bring the untracked documentation corpus into git

## Why
`git status` shows the project's institutional knowledge living UNTRACKED in the working tree: sprint
prompts (SPRINT-5A…SPRINT-9V, BASE-REVIEW), ADRs (001-009), audit briefs/reports, incident reports
(incl. INC-2026-06-03-001), runbooks, technical analyses. "Git history preserves everything" (rule #4)
is currently false for docs — one disk failure loses the audit trail.

## Task — classify, then commit. Branch `chore/docs-housekeeping`, PR into main. NO code changes.
1. **Inventory** all untracked files (git status). Classify each into exactly one bucket:
   a. **DOCS → commit.** Sprint prompts, ADRs, Audits/** (briefs, reports, incidents, Daily/Weekly/
      Monthly/Quarterly), Runbooks, docs/** (PITCH-DECK-BRIEF, OPS-HYGIENE-REVIEW, RUNBOOKS, planning
      md files at repo root like TERASWAP-EXECUTION-PLAN.md, QUESTIONS.md, REVIEW/SPRINT plans,
      FASE-A docs), and the audit PDFs/DOCX (binary but part of the audit trail — commit).
      Also include the MODIFIED `ROADMAP.md` (Architect WIP — commit as-is).
   b. **MARKETING → move OUT, do NOT commit (rule #10).** Anything that is marketing/social content:
      `TeraSwap_CoW_Reactivation_XThread.md`, `TeraSwap_DeFiUnsafe_Thread.md`,
      `tweet_propamm_quote_tweet.md`, `teraswap-x-thread-cowswap-incident.txt`,
      `TeraSwap_Competitive_Brief_2026-04-23.md` (competitive/marketing), `marketing.plugin`,
      `teraswap_7layer_verified_execution.png` (if promotional). Move to `../dex-aggregator 2.marketing/`
      (create an `inbox/` there if needed) and list the moves in the PR description. If unsure about a
      file, classify as marketing-suspect and ASK in FEEDBACK rather than committing.
   c. **TOOLING/CACHE → .gitignore, do NOT commit:** `.agents/`, `.claude/` (worktrees, skills, lock),
      `.hallmark/`, `cache/`, `contracts/cache/`, `health-reports/`, `reports/`, `lib/` (verify it's
      build/vendor — if it's foundry lib, it may belong to the submodule layout; investigate before
      ignoring), `clear-signing-erc7730-registry/` (vendored registry — ignore or document),
      `skills-lock.json`, `sprint-16-goal.html`, stray `workers/**/package-lock.json` (verify).
      Add precise .gitignore entries; do NOT gitignore docs paths.
2. **Secret scan BEFORE committing:** run gitleaks over the staged corpus (some docs discuss env
   breaches/keys — e.g. the Vercel breach incident docs, cowswap-inquiry). Anything with a REAL secret:
   redact (`<REDACTED>`) before commit and note it in FEEDBACK. Test fixtures rules from 9K do not
   apply here — no allowlisting docs; redact instead.
3. **Do NOT touch:** `contracts/order-engine/lib/openzeppelin-contracts` (dirty submodule — the
   chronic test-contracts issue, separate chore), any `src/**` code, `package*.json`, CI workflows.
4. Commits: split sensibly (e.g. `docs(adr)`, `docs(prompts)`, `docs(audits)`, `docs(runbooks)`,
   `chore(gitignore)`), all SSH-signed. CI green (docs-only must not break anything; gitleaks check
   must pass on the PR). Append FEEDBACK with the classification table (file → bucket) so the owner
   can audit the decisions.

## Acceptance
After merge, `git status` on a clean checkout shows no untracked documentation; marketing content is
out of the repo; caches ignored; no secrets committed; submodule untouched.
