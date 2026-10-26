# feat/ui-v2-landing — feedback

Branch off origin/main `f32ac28` (B1 merged, #610). No PR (owner opens it). Flow-B: code only under `src/ui/v2/**`, `src/app/v2/**`, `src/proxy.ts`.

## Checklist
- [ ] C1 (a) `/` → Swap tab · (b) `_enable` page + cookie flow · (c) subtitle "Change" · (d) Ethereum DCA gate tests · (e) credit in footer
- [ ] C2 landing (10 sections) at `/`
- [ ] C3 content-parity gate
- [ ] Verify: suite vs main · lint delta · tsc · build · v1 module-identical proof · diff --stat

## Owner decisions (asked mid-run; they supersede the goal text)
- (d) **Truthful per live chain.** The gate already exists; the "skeleton" on Preview = `NEXT_PUBLIC_DCA_ENABLED` unset there, so no chain is DCA-live. Arbitrum is named only when `isDcaLive(42161)`. Env note below.
- (c) "Change" on all three networks (Base's "Swap · DCA" dropped too).
