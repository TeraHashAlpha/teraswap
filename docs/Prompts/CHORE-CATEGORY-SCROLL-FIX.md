# CHORE-CATEGORY-SCROLL-FIX — category chips DON'T scroll horizontally (real-browser fix)

## Context
The token-selector category chips row (Native, Stablecoin, Wrapped BTC, Liquid Staking, …) has
`flex-nowrap overflow-x-auto no-scrollbar` on `main`, and CHORE-DCA-UX-TWEAKS added a JSDOM regression test —
but **it does NOT actually scroll in a real browser** (owner confirmed, tried multiple ways). The JSDOM test
passes because JSDOM does **no layout/overflow** — so it gave false confidence. This is a real CSS/layout bug.

## Objective
Make the category chips row genuinely scroll horizontally to reveal ALL categories, verified in a REAL browser
(not JSDOM).

## Requirements
1. **Diagnose the real cause in a rendered browser** (Playwright/headed against the dev server or a Preview).
   Check, on the chips container: is `scrollWidth > clientWidth` (does it actually overflow)? Is an ANCESTOR
   clipping it (`overflow: hidden` / a fixed width)? Is the row truly `flex-nowrap` with non-shrinking chips
   (`flex-shrink-0` on each chip), or do they wrap/compress to fit? Is `overflow-x-auto` on the element that
   overflows (not a parent/child)?
2. **Fix so it scrolls:** the scroll container must have a **bounded width** (e.g. `w-full` / `max-w-full`)
   with an inner `flex-nowrap` row of **`flex-shrink-0`** chips that overflow it, `overflow-x-auto`, and **no
   ancestor** with `overflow: hidden` clipping the horizontal axis.
3. **Make it usable on desktop too:** trackpad 2-finger + touch swipe must work; for **mouse users** add a
   drag-to-scroll handler and/or a visible affordance (edge fade + optional arrows) so it's discoverable. Keep
   `no-scrollbar` aesthetics if desired, but it must be operable without a visible scrollbar.
4. **Verify in a real browser, not JSDOM:** assert `scrollWidth > clientWidth` when categories overflow, that
   programmatic + user scroll changes `scrollLeft`, and that the LAST category becomes fully visible after
   scrolling. Replace/augment the JSDOM-only test with a real-render check (Playwright component/e2e).

## Do NOT
- Don't rely on a JSDOM test to prove scrolling (it can't). Don't break the chips' filter behaviour or wrap
  them. Don't touch the order engine / contract / keeper.

## Files affected (verify on main)
- The token-selector category-chips row component + its container/ancestors' overflow/width classes.

## Expected output
- Branch `chore/category-scroll-fix` off latest `origin/main`; SSH-signed; CI green; a REAL-browser test
  (Playwright) proving horizontal scroll + last-category reachable; FEEDBACK with the diagnosed root cause
  (which ancestor/class was the culprit) + a before/after note. No Auditor (pure UI).

## Quality criteria
The category row scrolls horizontally in a real browser (touch, trackpad, AND mouse-drag), all categories
reachable incl. the last, with a discoverable affordance; the proof is a real-render test, not JSDOM.
