# CHORE-NAV-TABS-NO-CLIP — ModeTabs desktop label clipping ("Analytics" -> "Analy")

> **Source:** owner screenshot 2026-07-23 — the top nav bar clips tab labels on wider viewports.
> Display/UX only, no routing/gating change → no Auditor gate. Branch `chore/nav-tabs-no-clip`,
> dedicated worktree. **Exit = push + suite green + compare link; owner opens the PR.**

## Root cause

`src/components/ModeTabs.tsx`'s tab row applies `sm:flex-1` to every tab button at the `sm:`
breakpoint (≥640px), while its outer container is capped at a fixed `sm:max-w-[540px]`. `flex-1`
sets `flex-basis: 0%` with `flex-shrink: 1`, so at `sm:` the row force-shrinks every tab to an equal
share of 540px regardless of label length — the exact squeeze the component's own header comment
already diagnosed and fixed for **mobile** ("the OLD inline tab bar gave each button flex-1 …
squished … the right-most (Analytics) was visually clipped"), except the `sm:` override
re-introduces that same squeeze on desktop. `sm:max-w-[540px]` was sized for the original 6-tab
set; it was never widened when the tab list grew (or whenever it later grows again, e.g. a re-wired
Limit/SL·TP), so any label set wider than 540px worth of equal shares clips again.

## Fix

Extend the SAME mechanism the component already uses correctly on mobile — natural
(`whitespace-nowrap`, `shrink-0`) tab width + a genuinely scrollable row — to every breakpoint,
instead of switching to a force-shrink strategy at `sm:`:

1. **Button:** remove `sm:flex-1` (and its paired `sm:px-2` padding override) entirely. `shrink-0`
   from the base class now applies unconditionally, so a tab's rendered width always matches its
   label's natural (`whitespace-nowrap`) content width at every viewport — never squeezed below it.
2. **Container:** the outer wrapper still caps at `max-w-[calc(100vw-1.5rem)]` (page-width safety,
   unprefixed = applies at every breakpoint now, replacing the old `sm:max-w-[540px]` override), but
   switches to `sm:w-fit` — it hugs the tabs' natural total width instead of stretching/shrinking to
   a fixed pixel value. Below `sm:` it stays `w-full` (unchanged, mobile behaviour is untouched).

Net effect: **desktop widens automatically to fit however many tabs are passed in** (today's 6, or a
future 8 with Limit/SL·TP re-wired) with zero label clipping, and if the tab set ever grows wider
than the viewport allows, it falls back to the *exact same* drag/wheel/touch-scrollable row already
proven correct on mobile — one clipping-proof mechanism for every screen size, not two.

## Do NOT

Change tab routing/gating, the "Soon" logic, or any component other than `ModeTabs.tsx`; add
dependencies; open a PR.

## Files affected (read ONLY these + new)

`src/components/ModeTabs.tsx`, its new test file, `docs/Prompts/CHORE-NAV-TABS-NO-CLIP.md`.

## Expected output

Branch + compare link. FEEDBACK ≤1 screen: the component found, the widen + overflow approach,
before/after of the clipping, tests. Owner validates on Preview at desktop + phone widths.
