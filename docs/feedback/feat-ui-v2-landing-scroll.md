# feat/ui-v2-landing-scroll — feedback

Branch off origin/main `cc30627` (B2, #614). Flow-B only: code under `src/ui/v2/**` + this file. No PR (owner opens it).

## Checklist
- [ ] C1 photo stack + cross-fade · [ ] C2 text entrance + reduced motion · [ ] C3 credit/icons/contrast · [ ] verify

## Owner answers (asked mid-run; supersede the goal text)
1. **Motion tokens:** `tokens.css` had only `--t-toast`/`--t-shimmer` → add `--ease-out/-inout`, `--t-fast/-base/-slow/-underline` there (MOTION-SPEC table), pinned in `tokens.test.ts`.
2. **Photos:** only Underpass existed in the repo → copy the 20 `round6/landing/img/bg-*` files into `src/ui/v2/photos/narrative/`, credits in `credits.json` (`narrative`).

## Evidence
(filled in at the end)
