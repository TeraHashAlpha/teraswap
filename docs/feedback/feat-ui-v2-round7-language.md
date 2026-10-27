# Feedback — feat/ui-v2-round7-language

Round 7 "no-box" language for v2 (owner decisions D1–D4, 26 Oct). Base: origin/main 5610beb (B2b merged). Code only under `src/ui/v2/**`.

## Checklist
- [ ] C1 fonts + tokens (Plex Sans, Latin ≤ 60 KB, guard, hairline/scrim/CTA tokens)
- [ ] C2 primitives (Surface, Button, Tabs, Chip, Input, Toggle, Skeleton) + `/v2/_kit`
- [ ] C3 shell + landing (§2 route race, §6 numbered list, scrims)
- [ ] Evidence 1–7 below

## Premises recorded
- (open) `/v2/_kit` is `src/app/v2/%5Fkit/` — outside `src/ui/v2/**`; the goal's "diff only under src/ui/v2/**" cannot hold if the kit shows the new variants.
- Goal says `--font-body`; the repo's token was `--font-sans` (Tailwind `v2-sans` reads it; `tailwind.v2.config.ts` is outside scope). Both now exist: `--font-body` = Plex Sans, `--font-sans` = alias.
- Pack ships no OFL text for Plex Sans; `OFL-ibmplexsans.txt` = the Plex Mono OFL (same holder/RFN). Architect to confirm.
