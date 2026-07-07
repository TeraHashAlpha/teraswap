# CHORE-MOBILE-UX-POLISH-2 — mobile harness CI fix + tap-target/text/landscape sweep (PR 2/2)

## Context
PR 1 (#242) shipped the tab-bar / overflow / critical-text / modal fixes + a mobile Playwright suite. But the
**E2E (real-render) workflow now FAILS on main**: the `mode-tabs` mobile tests do `page.goto(HARNESS)` →
`e2e/mobile/.harness/index.html` → **`ERR_FILE_NOT_FOUND`** — the esbuild+Tailwind harness isn't built/committed
in CI (the category-scroll harness builds, the new mobile one doesn't). PR 2 is the deferred catalog from #242's
FEEDBACK: the comprehensive ≥44px tap-target sweep + remaining sub-12px text + WalletModal landscape scroll.

## Requirements
0. **FIX THE CI HARNESS FIRST (unblocks main + this PR's own CI).** The mobile Playwright suite's `file://`
   harness (`e2e/mobile/.harness/index.html`) is missing in CI → `ERR_FILE_NOT_FOUND`. Add a CI step that
   **builds the harness** (esbuild + compiled Tailwind) before the Playwright run — mirror however the
   working category-scroll harness is produced — (or commit a generated harness + its build script + wire it
   into the E2E workflow). The mobile suite must run **green in CI** (not skipped, not failing).
1. **Tap-target sweep ≥44px** across the #242 FEEDBACK catalog: SwapBox, Portfolio, the DCA form, the **#236
   Positions dashboard cards**, the category/period chips, the filter chips — anything measured 10–34px → make
   it ≥44px (padding / min-size), without breaking the layout.
2. **Remaining sub-12px critical text → ≥12px** (readable on phones; numbers don't truncate/overflow).
3. **WalletModal landscape scroll:** ensure it scrolls/fits in landscape — no trapped or cut-off content.
4. **Verify on REAL mobile viewports** (Playwright iPhone SE 375 / iPhone 14 390 / Pixel 7 412): assert
   tap-target sizes ≥44px on the swept controls, text ≥12px, no horizontal overflow, modal fit (incl.
   landscape). Before/after screenshots. **NOT JSDOM.**

## Do NOT
- Don't regress desktop or PR 1's fixes. Don't change business logic / keeper / contract. Don't skip/disable
  the mobile suite to make CI pass — actually fix the harness.

## Files affected (verify on main)
- The E2E mobile workflow + the harness build (requirement 0).
- Per-tab components: SwapBox, Portfolio, DCA form + Positions dashboard cards (#236), chips/filters,
  WalletModal.

## Expected output
- Branch `chore/mobile-ux-polish-2` off latest `origin/main`; SSH-signed; **CI green incl. the now-fixed E2E
  mobile harness** (mode-tabs + tap-target tests actually run + pass); Playwright mobile tests + before/after
  screenshots; FEEDBACK confirming the harness root cause + the swept controls. No Auditor.

## Quality criteria
The E2E mobile suite runs green in CI (no ERR_FILE_NOT_FOUND); on a 375px phone, the swept controls are ≥44px,
text ≥12px, no overflow, WalletModal works in landscape; desktop + PR 1 unchanged; proof is real-device
Playwright, not JSDOM.
