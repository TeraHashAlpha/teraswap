# Feedback — feat/ui-v2-round7-language

Round 7 "no-box" language for v2 (owner decisions D1–D4, 26 Oct). Base: origin/main 5610beb (B2b merged). Code only under `src/ui/v2/**`.

## Checklist
- [x] C1 fonts + tokens (Plex Sans, Latin ≤ 60 KB, guard, hairline/scrim/CTA tokens) — 725f382
- [x] C2 primitives (Surface, Button, Tabs, Chip, Input, Toggle, Skeleton) + `/v2/_kit`
- [ ] C3 shell + landing (§2 route race, §6 numbered list, scrims)
- [ ] Evidence 1–7 below

## Premises recorded
- `/v2/_kit` is `src/app/v2/%5Fkit/` — outside `src/ui/v2/**`. **Owner answer (27 Oct): allow exactly `kit-demo.tsx` + `page.test.tsx` there**; diff scope = `src/ui/v2/**` + those two files + this feedback file. Supersedes the goal's wording.
- Goal says `--font-body`; the repo's token was `--font-sans` (Tailwind `v2-sans` reads it; `tailwind.v2.config.ts` is outside scope). Both now exist: `--font-body` = Plex Sans, `--font-sans` = alias.
- Pack ships no OFL text for Plex Sans; `OFL-ibmplexsans.txt` = the Plex Mono OFL (same holder/RFN). Architect to confirm.
- `Panel` stays frozen at its legacy boxed look through C2 (not yet an alias of `Surface`): unboxing it before the landing has scrims would leave text on bare photo. C3 migrates every caller and flips it to the alias.
- Input idle underline uses `--hairline-ring` (α .47 = 3.91:1 on --bg), not `--hairline` (α .16 = 1.45:1): WCAG 1.4.11 needs ≥ 3:1 for a field edge. Separators stay at .16 (decorative).
- Dropped one invalid contrast case I first wrote (text over a scrim over pure white): scrims sit on pre-graded photos, never white. Worst valid case (brightest graded pixel): thinnest margin is `muted` on `--scrim-left-race` = 4.72.
