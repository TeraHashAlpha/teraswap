# CHORE-FEEDBACK-MERGE-UNION — stop recurring FEEDBACK.md merge conflicts

## Context
`FEEDBACK.md` is append-only (each prompt appends a section). When two branches both append, they conflict on
merge/rebase (this delayed #228). A git **union merge driver** auto-concatenates both sides on conflict —
perfect for an append-only log.

## Requirements
1. Add to `.gitattributes` (create if absent) at the repo root:
   ```
   FEEDBACK.md merge=union
   ```
2. Confirm the repo has no conflicting `.gitattributes` entry for that path. (The union driver is built into
   git; no config registration needed for the `union` built-in.)
3. Note in the PR description that this only affects conflict resolution for `FEEDBACK.md` (append-only log) —
   no behaviour/code change.

## Do NOT
- Don't apply `merge=union` to any other file (only the append-only FEEDBACK.md). Don't touch code.

## Expected output
- Branch `chore/feedback-merge-union` off latest `origin/main`; SSH-signed; CI green; FEEDBACK appended (which
  also exercises the new attribute). One-line change.

## Quality criteria
`.gitattributes` has `FEEDBACK.md merge=union`; future append-only FEEDBACK conflicts auto-resolve by union.
