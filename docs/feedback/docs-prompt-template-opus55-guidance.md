# Feedback — docs/prompt-template-opus55-guidance

## Task checklist

- [x] Edit 1: §1 CONTROL header — add stopping rule SECOND line
- [x] Edit 2: New §1b "Finish line" — exit condition requirements
- [x] Edit 3: New §1c "What NOT to write" — no "think carefully", ask for evidence
- [x] Edit 4: §4 "Expected output" — feedback file in first commit with checklist, tick items as you go
- [x] Edit 5: §2 "Auditor gating" — add large-scope split rule + recon question answer-once rule
- [x] Edit 6: New §6a "UI goals" — design habits to leave out list requirement
- [x] Top blockquote — add "Updated 2026-09-23 per Anthropic's Opus 5.5 guidance" link
- [x] CLAUDE.md "Code Agent Feedback Convention" — add feedback file lifecycle (first commit, updated as you go)
- [x] CLAUDE.md rule 15 — add stopping rule (2026-09-19 reason)
- [x] Run `check-agents-parity.mjs` pre-changes — confirmed drift detected
- [x] Apply parity script --write — AGENTS.md hash updated
- [x] Verify parity check passes — OK

## Acceptance

All six edits present in template with Opus 5.5 link in blockquote. CLAUDE.md feedback convention + rule 15 added. Parity script output before and after shown below. Dogfood rule 4 applied: feedback file created in first commit.

## Parity script output

**Before:** `AGENTS.md is out of sync with CLAUDE.md` → drift detected (expected due to rule 15 + feedback convention edits)

**After:** `AGENTS.md parity OK: e5462e4d918bf5746694f6479dd2fbe080608fa635fb8aeaf7acffd24b17e975`

## Diff summary (git diff --stat)

Template, CLAUDE.md, AGENTS.md only. No other files touched.
