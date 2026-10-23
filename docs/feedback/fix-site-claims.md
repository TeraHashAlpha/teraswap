# Feedback — fix/site-claims

Goal: product claims as slots of `src/config/product-claims.ts`; beta/experimental out of the UI; one footer risk line.
Owner rulings recorded in-session (supersede the goal text):
- **C2:** the Security section has no "7 items" (a bare `value: 7` + 2 listed checks). Owner chose: `VERIFICATION_CHECKS` = only checks the in-list code proves.
- **Commit 3:** owner accepted reading/editing `app/providers.tsx`, `SwapBox.tsx`, `DCAPanel.tsx`, `LimitOrderPanel.tsx`, `ConditionalOrderPanel.tsx`, limited to the Beta* import + the one JSX usage line.

## Checklist
- [x] Commit 1 — product-claims slots (C1–C4) + anti-hard-code test
- [x] Commit 2 — copy C5–C7
- [ ] Commit 3 — beta out, footer risk line
- [ ] Verify: suite vs origin/main, lint delta 0, tsc, diff --stat
- [ ] Evidence 1–5 below filled, branch pushed, compare link

(Evidence sections are written at the end of the run.)
