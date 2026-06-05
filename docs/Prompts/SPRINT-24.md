# Sprint 24 — Mobile UX Overhaul

**Date:** 2026-05-19
**Architect:** Claude (Senior Architect)
**Branch:** `ui/mobile-ux` (single branch, single PR)
**Estimated effort:** ~1 pw (3 prompts)

---

## Motivation

TeraSwap is a PWA with Capacitor mobile build, but the frontend was designed desktop-first. On a 375px viewport (iPhone SE / iPhone 14) several UX issues degrade the experience: cramped tab bar with hidden horizontal scroll, touch targets below Apple HIG 44px minimum, modals that don't use bottom-sheet patterns on mobile, and missing safe-area-inset handling for notch/Dynamic Island devices.

This sprint addresses all 10 mobile pain points identified in the architecture review. No contract or backend changes — pure frontend.

---

## RICE

| # | Scope | R | I | C | E (pw) | RICE | Pri |
|---|-------|---|---|---|--------|------|-----|
| 135 | Tab bar + touch targets + safe area + tap feedback | 10 | 3 | 0.9 | 0.30 | 90.0 | P0 |
| 136 | Bottom-sheet modals (WalletModal, TransactionPreview, SlippageModal) | 10 | 2 | 0.85 | 0.35 | 48.6 | P1 |
| 137 | Header mobile polish + QuoteBreakdown expand + Analytics responsive + Footer spacing | 10 | 2 | 0.8 | 0.35 | 45.7 | P1 |

---

## Prompt 135 — Tab Bar, Touch Targets, Safe Area & Tap Feedback

### Context

**Tab bar** (`page.tsx` lines 87–122): 7 tabs in a `flex overflow-x-auto no-scrollbar` container. On 375px, the last 2–3 tabs (Orders, History, Analytics) are off-screen with no visual cue that scrolling is possible. Tabs use `px-2 py-2 text-[11px]` — well below Apple HIG 44px minimum.

**Safe area insets** (`globals.css` line 276–281): `env(safe-area-inset-bottom)` exists on `.sticky-bottom` and header, but the main swap area content (`page.tsx` line 80: `px-3 pb-8 pt-20`) doesn't account for bottom safe area. The tab bar is `sticky top-0` but doesn't use `env(safe-area-inset-top)`.

**Tap feedback**: `playTouchMP3()` exists for audio, but no visual `:active` state on buttons. CSS `--tap-highlight` variable exists but is unused.

### Objective

Make the core swap experience feel native on mobile.

### Requirements

1. **Tab bar redesign for mobile** — In `page.tsx`:
   - On `sm:` and above: keep current layout (all tabs visible in a row)
   - On mobile (<640px): split into two rows OR use a scrollable row with:
     - Fade gradient on the right edge (8px wide, `mask-image: linear-gradient(...)`) to hint more tabs exist
     - `scroll-snap-type: x mandatory` + `scroll-snap-align: start` on each tab
     - Optional: small dot indicators below the tab bar showing scroll position
   - Increase touch targets to minimum 44px height: change `py-2` to `py-3` on mobile, keep `py-2` on `sm:`
   - "Soon" badges: use `text-[7px]` on mobile instead of `text-[8px]` to save horizontal space

2. **Global touch target audit** — Ensure all interactive elements meet 44px minimum on mobile:
   - `SwapBox.tsx` line 577: 50% and MAX buttons — add `min-h-[44px] min-w-[44px]` wrapper or increase padding
   - `SwapBox.tsx` line 587: Invert button — already `h-11 w-11` (44px) ✅
   - `SwapBox.tsx` line 623–633: MEV toggle — toggle track is `h-6 w-10` but the tappable area should extend via padding
   - `QuoteBreakdown.tsx`: "Edit" slippage link — wrap in a tappable area
   - `Footer.tsx`: Links are `text-[11px]` with no padding — add `py-2` to each link on mobile for finger-friendly taps
   - `Header.tsx` line 104–110: Mobile menu hamburger is `h-10 w-10` — bump to `h-11 w-11`

3. **Safe area insets** — In `globals.css`, extend safe area support:
   ```css
   /* Already exists for .sticky-bottom — extend to swap main area */
   @supports (padding: env(safe-area-inset-bottom)) {
     .swap-main {
       padding-bottom: calc(2rem + env(safe-area-inset-bottom));
     }
   }
   ```
   - In `page.tsx` line 80: add `swap-main` class to the `<main>` element
   - Tab bar (`sticky top-0`): add `top: calc(var(--beta-banner-h, 0px) + env(safe-area-inset-top, 0px))` when inside the swap view (not landing)

4. **Tap feedback** — In `globals.css`, add a global active state:
   ```css
   button:active, a:active, [role="button"]:active {
     transform: scale(0.97);
     transition: transform 0.1s ease;
   }
   ```
   And use the existing `--tap-highlight` variable:
   ```css
   button:active, [role="button"]:active {
     background-color: var(--tap-highlight);
   }
   ```
   Exclude specific elements that already have custom active states (invert button, swap button).

### Do NOT

- Do NOT change the tab list order or add/remove tabs
- Do NOT change any logic or state management — purely visual/layout changes
- Do NOT add new dependencies
- Do NOT change desktop layout (all changes gated behind `sm:` or `@media (max-width: 639px)`)

### Files affected

| File | Action |
|------|--------|
| `src/app/page.tsx` | Tab bar mobile layout, safe area class on main |
| `src/app/globals.css` | Safe area extension, tap feedback, scroll fade mask |
| `src/components/SwapBox.tsx` | Touch target padding on 50%/MAX/MEV toggle |
| `src/components/QuoteBreakdown.tsx` | Tappable area on edit slippage |
| `src/components/Footer.tsx` | Touch-friendly link padding on mobile |
| `src/components/Header.tsx` | Hamburger size bump |

### Expected output

- All files modified, `npm run build` passes, `npm run lint` (via `npx eslint`) passes
- On 375px viewport: all tabs reachable, all buttons ≥44px tap area, content doesn't clip behind notch/home indicator
- On desktop (≥640px): zero visual changes

### Quality criteria

- No horizontal overflow / unwanted scrollbar on body
- Tab bar scroll snap works smoothly
- Tap feedback visible but subtle (not distracting)
- Footer links easily tappable with thumb

---

## Prompt 136 — Bottom-Sheet Modals

### Context

Three modals currently use different patterns on mobile:

1. **TokenSelector** (`TokenSelector.tsx` line 215): Already uses bottom-sheet on mobile (`items-end sm:items-start`) with `rounded-t-2xl`. ✅ Good baseline to follow.

2. **WalletModal** (`WalletModal.tsx` line 112): Opens top-right with fixed `w-[320px]`. On 375px this leaves only 55px margin. Not a bottom-sheet — feels like a desktop popover.

3. **TransactionPreview** (`TransactionPreview.tsx` line 136): `fixed inset-0 flex items-center justify-center p-4`. Centred modal, no bottom-sheet. This is the most critical modal — users confirm swaps here.

4. **SlippageModal** (`SlippageModal.tsx` line 66): Already uses bottom-sheet on mobile (`items-end sm:items-center`). ✅ Good.

### Objective

Make WalletModal and TransactionPreview use the bottom-sheet pattern on mobile, consistent with TokenSelector and SlippageModal.

### Requirements

1. **WalletModal** — Convert to bottom-sheet on mobile:
   - Mobile (<640px): `fixed inset-0 z-[100] flex items-end justify-center` (instead of `items-start justify-end pt-[72px] pr-4`)
   - Content: `w-full rounded-t-2xl` (instead of `w-[320px] rounded-2xl`)
   - Add backdrop overlay: `bg-black/60 backdrop-blur-sm` behind the modal
   - Add drag-to-dismiss hint: small 4px × 40px grey pill at top centre (`rounded-full bg-cream-15 mx-auto mb-3`)
   - `sm:` and above: keep current top-right popover behaviour (no changes)

2. **TransactionPreview** — Convert to bottom-sheet on mobile:
   - Mobile (<640px): Change `items-center justify-center` to `items-end justify-center`
   - Content: Change `max-w-md rounded-2xl` (or whatever current) to `w-full max-h-[85vh] overflow-y-auto rounded-t-2xl`
   - Confirm/Cancel buttons: make full-width, stacked vertically, 48px height, sticky at bottom with `pb-[env(safe-area-inset-bottom, 0px)]`
   - Add drag pill at top
   - `sm:` and above: keep centred modal

3. **Consistent dismiss behaviour**:
   - All bottom-sheets: tap backdrop = dismiss (already works)
   - All bottom-sheets: swipe down on the drag pill or header = dismiss (optional, nice-to-have, skip if complex)

### Do NOT

- Do NOT change TokenSelector or SlippageModal — they already work
- Do NOT change any modal logic, just layout/positioning
- Do NOT add animation libraries — use CSS transitions or existing framer-motion

### Files affected

| File | Action |
|------|--------|
| `src/components/WalletModal.tsx` | Bottom-sheet on mobile |
| `src/components/TransactionPreview.tsx` | Bottom-sheet on mobile, sticky confirm buttons |

### Expected output

- Both files modified, build passes
- On 375px: modals slide up from bottom, full-width, drag pill visible
- On desktop: unchanged
- Confirm/Cancel buttons reachable without scrolling on TransactionPreview

### Quality criteria

- Bottom-sheet content doesn't exceed 85vh (scrolls if needed)
- Safe area respected at bottom of confirm buttons
- Backdrop dismiss works
- Smooth appearance (prefer `animate-slide-up` or CSS transform transition)

---

## Prompt 137 — Header, QuoteBreakdown, Analytics & Footer Polish

### Context

**Header** (`Header.tsx`): Connect wallet button `px-3 py-2 text-[11px]` competes with logo on narrow screens. "CONNECT WALLET" text is long.

**QuoteBreakdown** (`QuoteBreakdown.tsx` line 270): Rate text uses `truncate` — on 375px this hides the exchange rate. The breakdown has multiple detail rows that can overflow.

**AnalyticsDashboard** (`page.tsx` line 147): Uses `max-w-[820px]` — charts and tables designed for wider viewports. Need to verify they stack properly on mobile.

**Footer** (`Footer.tsx`): Uses `flex-wrap` which works, but items are cramped with `gap-x-3`. On mobile, some items are hidden (`hidden sm:inline`) which is good, but the remaining items still feel tight. Block number and "No infinite approvals" are correctly hidden.

### Objective

Polish remaining mobile rough edges for a cohesive experience.

### Requirements

1. **Header mobile optimisation** (`Header.tsx`):
   - Connect wallet button: On mobile, use short text "CONNECT" instead of "CONNECT WALLET". Use `<span className="hidden sm:inline"> WALLET</span>` pattern.
   - When connected: `account.displayName` is already short (truncated by RainbowKit). ✅
   - ThemeToggle: verify it has ≥44px tap area, add padding if needed

2. **QuoteBreakdown mobile** (`QuoteBreakdown.tsx`):
   - Rate display (line 270): On mobile, wrap to two lines instead of truncating. Use `sm:truncate` (truncate only on sm+, full text on mobile with `text-wrap`)
   - Detail rows: ensure they use `flex-wrap` so labels and values don't overflow

3. **AnalyticsDashboard responsive** — Check `AnalyticsDashboard.tsx`:
   - If charts use fixed pixel widths, make them `w-full`
   - Tables: add `overflow-x-auto` wrapper if not already present
   - Cards/grid: ensure they stack to single column on mobile (`grid-cols-1 sm:grid-cols-2`)
   - This may require reading the full component — adjust as needed

4. **Footer mobile spacing** (`Footer.tsx`):
   - Increase `gap-y-1` to `gap-y-2` for better row separation when wrapped
   - Links already have `transition hover:text-cream` — add `active:text-cream` for touch feedback
   - Consider grouping into two rows on mobile: top row = nav links, bottom row = legal + copyright

5. **SwapHistory / WalletHistory** — Quick check: ensure these components don't have fixed-width elements that overflow on 375px. If they use tables, wrap in `overflow-x-auto`.

### Do NOT

- Do NOT change functionality
- Do NOT modify API calls or data handling
- Do NOT change desktop layout for Header, Footer, or QuoteBreakdown
- Do NOT rewrite AnalyticsDashboard — just add responsive wrappers where needed

### Files affected

| File | Action |
|------|--------|
| `src/components/Header.tsx` | Short connect text on mobile |
| `src/components/QuoteBreakdown.tsx` | Rate text wrap instead of truncate |
| `src/components/AnalyticsDashboard.tsx` | Responsive grid + table overflow wrappers |
| `src/components/Footer.tsx` | Gap spacing + touch feedback |
| `src/components/SwapHistory.tsx` | Overflow audit (if needed) |
| `src/components/WalletHistory.tsx` | Overflow audit (if needed) |

### Expected output

- All relevant files modified, build passes
- On 375px: header not cramped, rate visible, analytics usable, footer links tappable
- On desktop: zero visual changes

### Quality criteria

- No text truncation that hides critical swap information on mobile
- Analytics charts/tables scrollable on narrow viewport
- All interactive elements ≥44px touch target
- Consistent visual language across mobile views

---

_Sprint 24 deliverables: mobile UX overhaul across ~10 components. Zero backend/contract changes. All improvements gated behind mobile breakpoints — desktop experience unchanged._
