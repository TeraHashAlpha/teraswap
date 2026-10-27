# fix/ui-v2-landing-transition — feedback

Branch off origin/main `5610beb` (B2b, #615 merged). Owner review of the 26 Oct preview. Flow-B only: `src/ui/v2/**` + this file. No PR (owner opens it).

## Checklist
- [x] C0 feedback file + photo inventory
- [ ] C1 transition: 900 ms cross-fade + slow scale (`--t-photo`, `--t-photo-scale`)
- [ ] C2 uniform grade: Performance + bottom CTA move to the baked `bg-*` set
- [ ] verify: contrast (mid-fade 50 %), LCP / bytes, suite, 3 frames of one transition

## Photo inventory (before this branch)
| Section | Mechanism | Files | Grade |
|---|---|---|---|
| Hero | `PhotoBackground` `trails` | `pexels-30180436-…-light-trails-{1080,1920}` (round 4/5) | CSS grade + cream duotone + veil + fades + halftone dots |
| Performance (page §3) | `PhotoBackground` `arch-night` | `pexels-35632241-…-arch-night-{1080,1920}` (round 4/5) | same CSS recipe + halftone |
| Why TeraSwap | none | flat `--bg` | — |
| Security | narrative stack `highway` | `narrative/bg-highway-*` | baked + constant veil |
| Experience | narrative stack `footbridge` (mobile: `highway`) | `narrative/bg-footbridge-*` | baked + constant veil |
| Features | narrative stack `tunnel` | `narrative/bg-tunnel-*` | baked + constant veil |
| Roadmap | narrative stack `archlight` (mobile: `tunnel`) | `narrative/bg-archlight-*` | baked + constant veil |
| Bottom CTA | `PhotoBackground` `trails` | round 4/5 `trails` | CSS recipe + halftone |
| Docs | narrative stack `underpass` | `narrative/bg-underpass-*` | baked + constant veil |
| Footer | none (credits only) | — | — |

The five narrative sections were already all `bg-*`. The "picotado" the owner sees is the round-4/5 halftone layer on Performance (§3) and the bottom CTA, which sit between the narrative photos. Hero is left alone (round 7 / B1b replaces its raster).
