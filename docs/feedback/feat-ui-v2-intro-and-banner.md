# feat/ui-v2-intro-and-banner

## Tasks
- [x] Commit 1: entry animation on the v2 landing (`landing/Intro.tsx`, `intro.css`, unit + Playwright tests)
- [ ] Commit 2: notice banner restyle. BLOCKED, see Premise
- [x] Verify: `agent-verify.sh --codeql`, `gen-claude-state --check`, v1 proof, branch sent, compare link

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

## 3. Banner (Commit 2 NOT done, needs the design)
`banner/` is missing, so no restyle and no before/after or contrast numbers (nothing to measure against). Inventory, read-only: `shell/NoticeBanner.tsx` renders
**one** variant, the teal "Notice" strip ("Enable notifications ...", ENABLE / NOT NOW; mounted once, `AppShell.tsx:97`). It has no warning or blocked variant:
the goal text is wrong there. Other strips are other components: toasts (`shell/toasts.tsx:125`, accents in `primitives/KitSheet.tsx:67`), the amber strip
in `docs-legal/DocsTabV2.tsx:106`. Design silent on all of them (absent), so all stay as they are. To finish: put `banner/` where the goal says and re-run.

## 4. Verify (`agent-verify.sh --codeql`, base 61c7388)
suite PASS 10480/0 (482 files) | lint-delta 0 new | tsc 0 | build ok | v1v2-parity PASS 111 | rpc-budget PASS 33 | CodeQL 13 vs 13, 0 new.
`gen-claude-state --check` failed once (my test file moved vitest 481 to 482), regenerated in its own commit, now passes.
v1 proof: 0 v1 source files changed; marker `ts_v2_intro_seen` is in one chunk, referenced only by `server/app/v2/page_client-reference-manifest.js`
(v1 `/` manifest, `index.html`, `page.js`: 0 hits). Diff vs main: 12 files, 10 in the feature commit plus CLAUDE.md and AGENTS.md.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/ui-v2-intro-and-banner

## 5. CI fixes after the first push (two red checks, both in the intro)

### 5.1 CI / full-suite: `intro.test.tsx:78` (test bug, component was right)
Cause: `vi.spyOn(sessionStorage, 'getItem')` is not hermetic. On Node 22 (CI) `sessionStorage` is jsdom's `Storage`: assigning
`sessionStorage.getItem = ...` is a named-property write, so jsdom stored an item called `getItem` (storage length 1 in the probe) and the real
method stayed. The spy never threw, `claimIntro` saw a working storage and correctly played the intro. On Node 25 (this Mac) `sessionStorage` is
Node's own Web Storage (constructor `Object`, the `--localstorage-file` warning in every run) and the same spy replaces the method, so it passed here.
Not order dependent: reproduced with the file alone on Node 22.23.5. Fix: `vi.stubGlobal('sessionStorage', { getItem() { throw }, setItem() { throw }, ... })`
(restored by the existing `unstubAllGlobals`), same assertion. Checked: Node 25 and Node 22, file alone, 5 shuffled seeds on Node 22, `src/ui/v2/landing` on Node 22.

### 5.2 E2E / v2-mobile-parity: `intro.pw.ts` "a touch scroll skips it and scrolls" (component bug)
Cause: the first `touchmove` unmounted the overlay (`setPlaying(false)`), i.e. it removed the very element under the finger. Chromium starts the
scroll gesture on that element; if the removal beats the scroll begin the gesture loses its target and the page never moves. On this Mac the scroll
begin wins (5/5 and 18/18 throttled runs scrolled, so the CI failure did NOT reproduce here as such), on the CI runner it lost. Forced the ordering to
prove the mechanism: removing the overlay synchronously on `touchstart` or `touchmove` gives 0/4 scrolled, hiding it with `pointer-events: none` and
leaving it in the DOM gives 4/4. Also noticed: "overlay gone" in the old test did not prove the gesture skipped it, because the overlay removes itself at 3.3 s.
No `preventDefault`, `touch-action` or scroll lock was involved (listeners passive, `touch-action: auto` on html/body/curtain, page 9176 px tall).
Fix: a skip marks the overlay `data-skipped` (opacity 0, curtain `pointer-events: none !important`) and unmounts at once only when no finger is down;
with a finger down it stays mounted until the last `touchend`/`touchcancel` (or its own animation end). New tests: 5 unit (`intro.test.tsx`) and one
Chromium spec asserting the overlay is still mounted and already skipped at the first `scroll` event; it FAILS on the old build (false/false) and passes now.
Verified: `CI=true` headless, the failing spec plus the new one, 10 separate invocations, 10/10; whole intro spec 12/12; touch probe under 1x/6x/20x CPU throttle 8/8 each.
Concern: other code that unmounts on a scroll or touch event while the finger is down would have the same hazard; not audited here.
