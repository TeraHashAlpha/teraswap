# feat/ui-v2-foundation — FEEDBACK (≤1 screen)

Goal: ADR-025 + switch, tokens/fonts/motion, primitives + dev kit. Flow-B: new code only under `src/ui/v2/**`
(+ switch, admin route, kit). Branch off origin/main 3a97f76; worktree `~/ts-worktrees/ui-v2-foundation`.

## Checklist
- [ ] C1 ADR-025 + switch (proxy rewrite) + admin route + tests
- [ ] C2 tokens.css / Tailwind v2 scope / fonts / motion + snapshot
- [ ] C3 primitives + `/v2/_kit` + tests
- [ ] Verify: suite vs main (312 files / 4880 tests, lint 93), tsc, build, diff --stat, bundle measurement
- [ ] Evidence 1–6 below

## Owner answers that superseded the goal text
- `api-auth.ts` is the `/v1` API-key verifier, not admin auth → reads outside the list approved (admin routes,
  #565 font guard, vitest config/package.json, an admin test). Admin gate = `verifyBearerToken` + per-route
  secret → new `UI_V2_ADMIN_SECRET` (**third env name**, not in the owner note; unset → 503).
- Switch design: in-page `next/dynamic` measured to ship v2 to v1 (ADR-025 "Rejected") → proxy rewrite `/`→`/v2`,
  with direct `/v2/*` → real 404 (tested). Owner chose this; the first attempt is kept on local branch
  `wip/ui-v2-inpage-switch` (unpushed).
- Pack has no top-level `fonts/` (it is `assets/fonts/`); §4 has no motion/scales → searched the pack: only
  `ARCHITECT_BRIEF.md:24` (toast 160 ms, shimmer 1.2 s, reduced motion) → those two tokens, no `--ease-*`.
