# feat/ui-v2-intro-and-banner

## Tasks
- [x] Commit 1: entry animation on the v2 landing (`landing/Intro.tsx`, `intro.css`, unit + Playwright tests)
- [ ] Commit 2: notice banner restyle. BLOCKED, see Premise
- [ ] Verify: `agent-verify.sh --codeql`, `gen-claude-state --check`, v1 proof, push, compare link

## Premise findings (asked once, then the conservative reading)
- `~/Desktop/teraswap-round2-pack/round10-intro-banner/` does not exist (pack folder empty); `banner/` exists nowhere on this Mac. **Commit 2 is not
  done**: designing it from memory is ruled out. `arc-reveal.mp4` was at `~/Downloads/arc-reveal.mp4` (1600x900, 3.9 s, `mdls`), used for Commit 1.
- The landing is **not** server-rendered: `src/app/client-providers.tsx` loads `Providers` with `ssr: false`. The overlay lives in `LandingV2` and mounts in the
  same commit as the landing (no flash of landing before it). Session flag: `sessionStorage` key `ts_v2_intro_seen` (set when it starts, also when skipped).
  Unreadable storage means no intro.
- The video's page under the arc is the pack mock (other nav, photo, copy); the built one is the repo's current landing.

## 1. Intro (video | built, 0.3 0.9 1.5 2.4 3.1 3.4 s)
`assets/feat-ui-v2-intro-and-banner/intro-frames-1440.jpg` and `intro-frames-375.jpg` (left video, right built). Real run, 202 frames (`intro.pw.ts`):

| event | video | built |
|---|---|---|
| Compare. / Verify. / Swap. / Repeat. appear | 0.03 / 0.63 / 1.23 / 1.83 s | 0.028 / 0.627 / 1.228 / 1.827 s |
| cut to next word | 0.60 / 1.20 / 1.80 s | 0.610 / 1.210 / 1.810 s |
| fade to 95 % | ~0.20 s | 0.115 s (token ease-out is steeper than the video's) |
| sweep start, page fully visible | 2.95 s, 3.33 s | 2.977 s, 3.327 s |

Differences: the fade is quicker (above); the arc is a mask sliding up (words stay put and are cut by it, as in the video) with an easing fitted to 4 video
positions; dot grid reuses the existing cream at 5 %. No new colour or font. Flashes: 1.67 per second.

## 2. Proofs (`intro.pw.ts`, real Chromium, 11/11)
Click skips and `elementFromPoint` on "Launch app" is the curtain (the app does not open); Tab, wheel (page scrolls), touch tap, touch scroll (page scrolls) skip;
reduced motion: no overlay, flag unset; JS off: server HTML has no overlay; JS cut off (overlay cloned out of React): its CSS alone ends it,
`visibility: hidden`, click-through; second load in session: none; `/swap /docs /privacy /terms`: none. Unit: `intro.test.tsx` 28.
Both Playwright rigs (`mobile.pw.ts`, `e2e/third-party-hosts/rig.ts`) now seed the flag so their first visit is not under the curtain.
