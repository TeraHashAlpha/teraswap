# fix/ui-v2-landing-transition — feedback

Off origin/main `5610beb` (B2b, #615). Owner review 26 Oct: photo change reads as a hard cut; mixed textures. Code only in `src/ui/v2/**`. SSH-signed, noreply. No PR.
- [x] C0 feedback + inventory · [x] C1 visible motion · [x] C2 uniform grade · [x] verify · [x] push

## 1 · Tokens + tests
`tokens.css`: `--t-photo:900ms; --t-photo-scale:1600ms` (zeroed under reduced motion; pinned in `tokens.test.ts`). Layer: opacity 900 ms `--ease-inout` + transform 1600 ms `--ease-out`, incoming 1.04→1.00, outgoing 1.00→1.03; opacity/transform only, no scroll-linked effect. **Supersedes MOTION-SPEC §3 "180 ms" by owner decision (26 Oct).** `--t-slow` stays 180 ms; the credit now fades on `--t-photo` so its name does not change before the photo. Reduced motion: no stack, 0 layer animations (checked in Chromium).

## 2 · Frames (`fix-ui-v2-landing-transition/frame-{0000,0450,0900}ms.webp`, numbers in `frames.txt`)
Security→Experience, animations seeked to t. out/in opacity 1/0 → .5/.5 → 0/1; scale out 1.000→1.024→1.029, in 1.040→1.008→1.002.

## 3 · Section → file
| Section | Before | After |
|---|---|---|
| Hero | round-4/5 `trails` (CSS grade + halftone) | **unchanged** (round 7) |
| Performance (spec §2) | round-4/5 `arch-night` + halftone | baked `bg-tunnel` (lazy) |
| Why TeraSwap | flat `--bg` | same |
| Security · Experience · Features · Roadmap · Docs | `bg-highway · footbridge · tunnel · archlight · underpass` | same (already all baked) |
| Bottom CTA (spec §8) | round-4/5 `trails` + halftone | baked `bg-highway` (lazy) |

**Premise corrected:** the five narrative sections were already 100 % `bg-*`; the halftone the owner saw is the round-5 grade on Performance/CTA, which MOTION-SPEC §1 kept "unchanged". Per the brief those two now use the baked set (same veil). Footer credit follows (hero · tunnel · highway authors).

## 4 · Verification
- Contrast (`contrast.txt`, 52 states incl. explicit 50 % mid-fade, both layer orders, AVIF+WebP, the 2 stills): 0 fails; muted body 5.87, still h2 ≥ 11.2.
- LCP median, 7 runs/side vs origin/main: desktop 348→348 ms, mobile 336→336 (limit +100). Hero file identical. **Image bytes at scroll 0 are lower, not unchanged**: 361,844→210,350 B desktop, 198,141→155,598 mobile (lazy Performance 181 KB→30 KB). All files ≤ 200 KB (`lcp-bytes.txt`).
- Suite 352 files / **5583** tests (B2b 5575); lint 93 = 93 (0 errors); tsc 0; build 0. v1: 0 files changed outside `src/ui/v2/**`, non-`/v2` route table identical.
- `git diff --stat origin/main`: 21 files, +~330/−44 (9 code, 5 tests, 7 evidence/docs). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/ui-v2-landing-transition

## Findings
- **Edge case:** a CSS keyframe for the incoming layer + a transition for the outgoing one did NOT work in Chromium (outgoing sat at 1.03 from t=0; no transform transition). Replaced by plain transitions and a `data-leaving` state set in the same commit as `data-active` (released after 1700 ms, pinned > `--t-photo-scale` by a test).
- Chrome headless cannot emulate `prefers-reduced-transparency`; covered by the shared CSS block + mocks (as in B2b).
