# fix/hero-stat-layout — feedback

Base `origin/main` 96005c4 (#587) · worktree `~/ts-worktrees/hero-stat-layout` · `npm ci` · markup + copy only.

## Checklist
- [x] C1 middle hero stat = numeral `VERIFICATION_CHECKS.length` + label `VERIFICATION CHECKS · ${VERIFICATION_STAGES.length} STAGES`
- [x] C1 tests: numeral === `VERIFICATION_CHECKS.length`, label has stage count, all 3 cells bare numerals, SSR final value
- [x] C2 hero paragraph last clause → "and offers MEV-protected routes via CoW Protocol." (+ wording test)
- [x] Suite vs main · lint delta 0 · tsc · diff --stat · push · compare link

## Scope notes
- Out-of-list `grep -l`/`grep -n` only: anti-hard-code test = `src/config/product-claims.no-hardcode.test.ts` (run, not read);
  no test asserts the hero paragraph.
- **Premise false (owner answered):** `LandingClaims.test.tsx:48-50` rendered `<LandingPage>` and pinned hero text
  `VERIFICATION_SUMMARY` → failed after C1. Owner: "Update that test" → file added to read list + diff; only that test
  re-pointed to the new shape (numeral `VERIFICATION_CHECK_COUNT`, label with `VERIFICATION_STAGE_COUNT`).
- Dead `text` branch of the `<dd>` removed (no cell uses it). SSR test logs the same framer-motion
  `useLayoutEffect` warning the existing LandingClaims SSR test already logs on main.

## Evidence
1. Middle cell — before → after (`LandingPage.tsx` HeroSection)
   ```tsx
   { text: VERIFICATION_SUMMARY, label: 'VERIFICATION' }   // <dd>: <span className="text-[20px]…">{s.text}</span>
   { v: VERIFICATION_CHECKS.length, label: `VERIFICATION CHECKS · ${VERIFICATION_STAGES.length} STAGES` }   // <dd>: <AnimatedCounter value={s.v} immediate />
   ```
2. Tests — `LandingPage.test.tsx` hero stat strip: numeral === `VERIFICATION_CHECKS.length` ✓ · label has stage count ✓ ·
   3 bare-numeral cells ✓ · SSR `renderToString` final value ✓ · MEV wording ✓. `LandingClaims.test.tsx` hero stats 2/2 ✓.
   Anti-hard-code `product-claims.no-hardcode.test.ts`: **131/131 passed**.
3. Hero paragraph — before → after (only the last clause; no test asserted it before, one now pins it)
   - "…verifies the price against Chainlink oracles, and routes through MEV-protected execution."
   - "…verifies the price against Chainlink oracles, and offers MEV-protected routes via CoW Protocol."
4. Verification (vs `origin/main` 96005c4, same worktree)
   - Suite: 304 files / **4730 passed** vs 4726 on main (+4 new, 0 failed, 0 skipped)
   - Lint: 0 errors / 93 warnings vs 0 / 93 — warning set identical (delta 0) · `tsc --noEmit`: clean
   - `git diff --stat origin/main...HEAD` (code): `LandingPage.tsx` 19 (+9/−10) · `LandingPage.test.tsx` +61 ·
     `LandingClaims.test.tsx` 8 (+5/−3, owner-approved) · + this feedback file. product-claims.ts untouched.
   - Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/hero-stat-layout (no PR opened)
