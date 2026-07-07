# CHORE-MOBILE-UX-POLISH — comprehensive mobile/smartphone UX audit + fix (real-device verified)

## Context
The app's UX on smartphones is in poor shape (owner). Do a thorough mobile pass across every view + modal,
fix the layout/usability problems, and VERIFY on REAL mobile viewports (Playwright device emulation) — NOT
JSDOM (it does no layout; a JSDOM test proves nothing for responsive UI, as the category-scroll fix showed).
Preserve the dark / constellation / green-accent aesthetic and do NOT regress desktop.

## Objective
Every tab, panel, modal, and flow is clean and usable at phone widths (360–430px): no horizontal page
overflow, readable text, comfortable tap targets, and tables/rows that don't break.

## Requirements
1. **Audit on real mobile viewports** (Playwright device emulation — e.g. iPhone SE 375px, iPhone 14, Pixel 7).
   Catalog every issue with the view + the problem (overflow, clipping, off-screen content, tiny tap targets,
   unreadable text, broken tables/modals). Put the catalog in FEEDBACK.
2. **Fix across all views:** Swap, Portfolio, DCA (panel + the #236 Positions dashboard), Orders, History,
   Analytics — plus the **top tab bar** (Swap/Portfolio/DCA/… must be reachable on mobile; the flagged
   tab-bar-fade limitation — reuse the CategoryChips horizontal-scroll approach from #235), the modals
   (OrderReviewModal / approve-then-sign, token selector), and the wallet-connect (RainbowKit) flow.
3. **Concrete mobile rules:**
   - **No horizontal page scroll** anywhere (nothing wider than the viewport).
   - **Tap targets ≥ 44px**; no cramped/overlapping controls.
   - **Readable text** (no sub-12px critical text; numbers don't truncate/overflow their containers).
   - **Tables (Analytics/History/Orders):** make them horizontally scrollable OR reflow to stacked cards on
     mobile — never a clipped/broken grid.
   - **Modals full-width + scrollable + easily dismissable** on mobile (not cut off, no trapped content).
   - Inputs/number fields usable (numeric keyboard, no zoom-jank, no overflow).
4. **Verify in a REAL browser, mobile viewports** (Playwright): assert no horizontal overflow per view,
   key controls visible + tappable, the tab bar scrolls, modals fit. Capture before/after screenshots.
   Do NOT rely on JSDOM for any responsive assertion.

## Do NOT
- Don't regress the desktop layout. Don't change the order engine / contract / keeper / business logic — UI
  only. Don't fabricate; keep the existing data flows.

## Files affected (verify on main)
- Layout / nav / tab bar (`page.tsx`), and the per-tab components: Swap, Portfolio, DCA panel + Positions
  dashboard, Orders, History, Analytics; shared modals + token selector + the responsive utility classes.

## Expected output
- Branch `chore/mobile-ux-polish` off latest `origin/main`; SSH-signed; CI green; **Playwright mobile-viewport
  tests** (no-overflow per view, tab-bar scroll, modal fit) + before/after screenshots; FEEDBACK with the full
  issue catalog + what was fixed vs deferred. No Auditor (UI). If the diff gets large, split into a focused
  first PR (worst offenders: tab bar, tables, modals, overflow) + a follow-up — note the split in FEEDBACK.

## Quality criteria
On a 375px phone: no horizontal scroll, every tab reachable + usable, tables/modals work, tap targets ≥44px,
text readable; desktop unchanged; proof is real-device Playwright screenshots/assertions, not JSDOM.
