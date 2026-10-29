# Feedback — feat/ui-v2-dca (B6a: DCA form + review + orders, display only)

Branch off `origin/main` 320cc26. Display + form only: no signing, no submission (the Create CTA is a stub; B6b wires it).
Everything under `src/ui/v2/dca/**` (+ the one-line pane switch in `src/ui/v2/shell/AppShell.tsx`). Nothing in `src/lib`, `src/hooks`, `src/app/api`, `src/components`.

## Checklist
- [ ] C1 form + Protection line (`DcaCard`, `use-dca-form`, `dca-model`) + tests
- [ ] C2 review sheet + consent + orders list + tests
- [ ] C3 chain gate + sounds table + a11y + mobile 375
- [ ] Evidence 1-7 below, v1 module-identical proof, suite / lint / tsc / build / rpc-budget guards

## Premise deltas (owner answer supersedes; v1 won where the goal text and v1 disagree)
Written as the work found them — see the final report for the questions.
