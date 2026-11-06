# Feedback — feat/ui-v2-design-review-1 (owner design review, 5 Nov)

Base origin/main `ff06085` (B10 / PR #660 merged 06 Nov 12:13Z, gate verified). Only `src/ui/v2/**` + this feedback. 4 signed commits, no PR (owner opens).

## Checklist
- [x] 1 platform green · [x] 2 no ⚠ in notices · [x] 3 no dark bands · [x] 4 underline + hero photo · [x] verify (below)

## 1 · Platform green — `#6B9B94`
It is `--teal` (`tokens.css`): the NOTICE strip's bar (`accent="teal"` → `border-v2-teal`) and label (`text-v2-teal`). **No v1 source** — the hex exists only in v2 (pack README §4); it is not `--green #7FC8A0`. New token `--c-accent-green: var(--teal)`; `.ts-v2-accent-stroke` / `.ts-v2-rule-accent` / `.ts-v2-rule-list` use it for notice/alert/toast bars, chip separators, section-label bars, card/column/list rules, wordmark bar, orders/analytics/portfolio notes. `Notice` keeps `data-tone`. Guard test `__tests__/design-review-1.test.ts` fails on any status-coloured left border.

## 2–3 · Evidence (before | after, 1440 + 375) — `docs/feedback/feat-ui-v2-design-review-1/`
blocked notice `notice-blocked-{d1440,m375}` · warning `notice-warning-*` · hero chips `hero-chips-*` · bands removed: hero `hero-*`, "What makes TeraSwap different" `why-*` (§2/§8 already had photos; footer left, see calls).
**Contrast** (WCAG, p95 backdrop, weakest scrim stop; need 4.5 body / 3 large + stroke; full: `contrast.txt`):

| section (scrim) | muted | text | cream | green stroke |
|---|---|---|---|---|
| hero (left .3 / down .45) | 6.62 | 14.22 | 12.35 | 5.29 |
| §2 performance | 6.95 | 14.94 | 12.98 | 5.56 |
| §3 why (down .45) | 6.66 | 14.31 | 12.42 | 5.32 |
| §8 CTA | 6.93 | 14.89 | 12.93 | 5.54 |
| stack sections (worst: docs) | 5.25 | 11.29 | 9.80 | 4.20 |

AA holds everywhere, so no STOP. H2 large text on the bare veiled photo: hero 12.90 / 11.20, why 11.96 / 10.39.

## 4 · Underline + hero
Underline hung `-bottom-1` off a .98em box = through the glyph bottoms. Now `-bottom-[0.13em] h-[0.2em]`, bottom-anchored; a unit test derives the band from font metrics (lh .95/.98). Measured: 375 → stroke 425.8–434.6 px, baseline ≈425, next caps ≈437; 1440 → 405.6–421.6, baseline ≈404, next caps ≈426; wrapped 320/1100 underline the last line. Images `underline-{375,1440}`.
Hero: the pack **does** specify one — overpass (MAG Photography, Pexels 37644721; round-6 MOTION-SPEC §2 "the overpass (hero and §8)", credit chip on the round-8 hero render). Baked `bg-overpass` via `NarrativeStill` (eager): AVIF 34.7 KB @1920 / 26.0 KB @1080 (≤200 KB). Light-trails is gone from the landing; `credits.json` updated (overpass `section: hero`, zakim `why`, trails retired). Why uses zakim (the pack's round-7 P4 proposal).

## 5 · Gates
Suite: head **430 files / 7725 tests** pass vs origin/main 429 / 7713 (+1 file, +12). (A parallel run flaked `sounds-parity` 2×; 12/12 alone ×2 and in the clean full run.) Lint 93 = 93 warnings, 0 errors · tsc 0 · `next build` 0 (both) · rpc-budget guards green · `check:product-claims`, `check:color-contrast` pass · **CodeQL security-extended 13 → 13, 0 new** · **v1 chunk contents identical** on all 10 v1 routes (sha256 of every chunk in each page manifest, base vs head) · no file outside `src/ui/v2` + feedback · no copy changes beyond the removed glyph, no deps/secrets/force-push.
`git diff --stat origin/main...HEAD~1`: 45 files, +322 −122 (feedback images / contrast excluded). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-design-review-1

## Judgement calls (owner may overrule)
- Wordmark bar (header + landing) converted to green ("every" stroke). Toasts too (all five types → green).
- ⚠ kept on **inline status indicators**, not notices: token badge, Rate marker + tooltips, Validation row, Active Approvals icon (allow-listed by count in the guard test).
- Footer is a slim legal strip shared with the app shell — left as the solid band. `.ts-exec-step` done-connector keeps `--green`.
- A wrapped underline still spans the wrapper's width (an svg can't hug a wrapped last line in CSS).
- Parity tests carry reasoned allow entries for the removed glyph and assert the title words verbatim.

## Feedback — design review 1 (9db0131, cf3d95c, 9f3fee3)
### Edge case
- A `top`-anchored underline looked right at 375/1440 but sat under the FIRST wrapped line at 320/1100; only measuring caught it.
### Concern
- `Notice`'s `tone` no longer changes colour; a future severity-by-colour request re-opens it.
