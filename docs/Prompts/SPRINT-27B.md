# Sprint 27B — Landing Page Redesign Fixes

**Sprint window:** 2026-05-21 → TBD  
**Sprint goal:** Fix the 5 highest-priority issues from the Sprint 27 landing page redesign (branch `redesign/landing-page`). Sprint 27 delivered a new page structure and content, but failed on several explicit requirements from the original brief: counters broken (show 0), background continuity lost on scroll, excessive dead space between sections, flat feature hierarchy, and swap preview buried too deep. This sprint fixes all 5 issues with atomic commits.  
**Owner:** TeraHash (founder/architect) + code agent  
**Prerequisite:** Sprint 27 branch `redesign/landing-page` exists with the redesigned `LandingPage.tsx` (1,046 lines), `ParticleNetwork.tsx` (333 lines), and `page.tsx` (160 lines).  
**Branch:** Continue on `redesign/landing-page`. Do NOT create a new branch.

**IMPORTANT:** This is a visual/UX-only sprint. Do NOT touch any files in `src/hooks/`, `src/lib/` (except `sounds.ts` if needed), `src/app/api/`, or any contract/blockchain code. Every prompt = 1 atomic commit.

> **Architect notes (2026-05-21):**
>
> 1. **Line numbers are from the pre-sprint state.** After P71 (section merge/delete), all line references for P72 and P73 will be stale. Use **component/function names** as primary references, not line numbers.
>
> 2. **P70 — verify `bg-surface` opacity support.** Tailwind's `/80` opacity modifier only works if `bg-surface` is defined as RGB channels (e.g. `--color-surface: 15 19 24`). If defined as hex (`#0F1318`), the modifier silently fails. Check `tailwind.config` before applying. Fallback: use `bg-[rgba(15,19,24,0.8)]` or convert the CSS variable to RGB channel format.

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| 69 | Fix hero counters showing zero | AnimatedCounter values hardcoded + noscript fallback | Pending |
| 70 | Fix section backgrounds hiding particles | Semi-transparent section bgs so particles show through | Pending |
| 71 | Eliminate dead space between sections | Reduce padding, lower animation thresholds, merge sections | Pending |
| 72 | Establish feature card hierarchy | 3 hero differentiators elevated, coming soon visually demoted | Pending |
| 73 | Move swap preview to hero area | Swap widget mockup moves from Experience section to above the fold | Pending |

---

## Prompt 69 — Fix hero counters showing zero

**Status:** Pending

**Context:** The `HeroSection` in `LandingPage.tsx` does NOT use `AnimatedCounter` — it has no counter stats at all. The hero section (lines 74–146) only contains the headline, subtitle, CTA button, and trust strip. The counters that appear in the live deploy ("0 LIQUIDITY SOURCES · 0 VERIFICATION LAYERS · 0 CHAINLINK ORACLES") are likely rendered via a different mechanism or an older component that was not fully integrated during Sprint 27.

Meanwhile, `AnimatedCounter` (lines 49–68) IS used in `PerformanceSection` (line 193: `<AnimatedCounter value={1} suffix="ms" />`) and `SecuritySection` (lines 592–596: values 7 and 29). These work correctly because `useInView` triggers when the section scrolls into viewport. The hero counters showing "0" are a separate bug — the values are never set because the counter component either isn't receiving the correct props or isn't mounted in the hero at all.

**Objective:** Add a stats bar to the hero section with three real metrics that count up on page load (not on scroll — hero is always in view). Values must be hardcoded with correct data: 11 Liquidity Sources, 2 Verification Layers, 29 Chainlink Oracles.

**Requirements:**

1. In `HeroSection` (line 82–144 of `LandingPage.tsx`), add a stats row between the CTA button (line 126) and the trust strip (line 128).
2. Render three stat items: `{ value: 11, label: 'LIQUIDITY SOURCES' }`, `{ value: 2, label: 'VERIFICATION LAYERS' }`, `{ value: 29, label: 'CHAINLINK ORACLES' }`.
3. Use `AnimatedCounter` for each value. Since the hero is visible on load, the `useInView` hook should fire immediately — but verify this works. If `useInView` doesn't trigger for elements already in the viewport on mount, add a fallback: set `once: true` on the ref and use `useState` with the target value as initial state.
4. Style: large bold numbers (`text-4xl sm:text-5xl font-bold text-cream`), uppercase label below (`text-[11px] tracking-[0.1em] text-cream-50`). Horizontal layout with `gap-12` between items, centered.
5. The stat values MUST render correctly even with JavaScript disabled — add a `<noscript>` block or ensure the initial `useState(0)` is replaced with `useState(value)` so SSR renders the final number.

**Do NOT:**
- Touch `AnimatedCounter`'s core logic (lines 49–68) — it works fine for scroll-triggered sections
- Add any new dependencies
- Change the PerformanceSection or SecuritySection counters

**Files affected:**
- `src/components/LandingPage.tsx` — `HeroSection` function only (lines 74–146)

**Expected output:** One commit. Hero section shows "11 LIQUIDITY SOURCES · 2 VERIFICATION LAYERS · 29 CHAINLINK ORACLES" with count-up animation on page load. Numbers never show as 0 to the user.

**Quality criteria:**
- Numbers visible within 100ms of page load (no waiting for scroll)
- Final values correct: 11, 2, 29
- Responsive: numbers stack vertically below `sm` breakpoint
- No hydration mismatch warnings in console

---

## Prompt 70 — Fix section backgrounds hiding particles

**Status:** Pending

**Context:** `ParticleNetwork.tsx` renders a `<canvas>` with `className="pointer-events-none fixed inset-0 z-30"` — it's position-fixed and covers the full viewport at z-index 30. The main content in `page.tsx` (line 75) is `relative z-10`. This means particles render ON TOP of the content, but with very low opacity (`BASE_LINE_OPACITY = 0.13`, particle alpha ~0.3–0.5).

Every landing page section has `bg-surface` (a solid opaque background, likely `#0F1318` or similar). Since sections are opaque at z-10 and particles are semi-transparent at z-30, the particles ARE technically visible but almost invisible against the dark opaque backgrounds. The hero section works because it has NO `bg-surface` class — the raw dark body shows through with more particle contrast.

The original Sprint 27 brief said: "Keep the particle network background but reduce its opacity so it doesn't compete with content." The intent was particles visible everywhere but subtle — NOT particles invisible everywhere except the hero.

**Objective:** Make the particle background subtly visible across all sections while keeping content readable. The page should feel like one continuous environment, not a hero with particles followed by flat dark sections.

**Requirements:**

1. In `LandingPage.tsx`, change all section `bg-surface` classes to `bg-surface/80` (80% opacity). This lets the underlying particle canvas bleed through slightly. Affected sections:
   - `PerformanceSection` (line 154): `bg-surface` → `bg-surface/80`
   - `SevenLayerSection` (line 423): `bg-surface` → `bg-surface/80`
   - `DifferentiationSection` (line 555): `bg-surface` → `bg-surface/80`
   - `SecuritySection` (line 599): `bg-surface` → `bg-surface/80`
   - `ExperienceSection` (line 712): `bg-surface` → `bg-surface/80`
   - `FeaturesSection` (line 881): `bg-surface` → `bg-surface/80`
   - `BottomCTASection` (line 948): `bg-surface` → `bg-surface/80`

2. In `ParticleNetwork.tsx`, reduce the canvas z-index from `z-30` to `z-0` (line 330). Then in `page.tsx`, ensure the main content `z-10` stays above. This is a cleaner architecture: particles behind content, but visible through semi-transparent section backgrounds.

3. After moving particles to z-0, add `backdrop-blur-[1px]` to sections that have dense text content (PerformanceSection, FeaturesSection) to prevent particles from distracting from readability. Do NOT blur the hero — particles should be crisp there.

4. Test that `pointer-events-none` still works correctly on the canvas at z-0.

**Do NOT:**
- Change particle count, speed, color, or any animation parameters
- Change the turbo/warp modes
- Remove `bg-surface` entirely — sections still need a dark foundation
- Add any new background images or gradients

**Files affected:**
- `src/components/LandingPage.tsx` — section className changes only
- `src/components/ParticleNetwork.tsx` — line 330, z-index change only
- `src/app/page.tsx` — verify z-index ordering still correct (may not need changes)

**Expected output:** One commit. Scrolling from hero through all sections shows a continuous subtle particle field behind the content. Particles are most visible in the hero (no bg), subtly visible in all other sections (semi-transparent bg), and never compete with text readability.

**Quality criteria:**
- Particles visible (however faintly) in every section — no section is 100% flat
- Text remains fully readable (WCAG AA contrast maintained)
- No z-index conflicts (no content hidden behind particles)
- Lighthouse Performance score ≥ 90 (no new paint layers that hurt performance)

---

## Prompt 71 — Eliminate dead space between sections

**Status:** Pending

**Context:** The Sprint 27 brief explicitly said: "Too much dead space between sections. Tighten the layout." and "Every scroll should reward the user with new information." The current deploy has the opposite problem — approximately 3 full viewport heights of empty space during a scroll-through. The causes are:

1. **Excessive section padding:** Every section uses `py-28` (7rem = 112px top + bottom = 224px total). For a page with 8 sections, that's ~1,800px of padding alone.
2. **High animation thresholds:** Many `whileInView` animations have `viewport={{ amount: 0.3 }}`, meaning 30% of the element must be visible before it animates in. Combined with large padding, this means content appears "late" as you scroll.
3. **Sequential reveal delays:** The `SevenLayerSection` reveals items one at a time with stagger, and the `SecuritySection` stat counters have delays. During these animations, the viewport shows mostly empty space.
4. **Redundant sections:** "Limitless Liquidity" (PerformanceSection) and "11 Liquidity Sources" (first card in FeaturesSection) convey the same message. "Security Pipeline" (SevenLayerSection), "Institutional-Grade Security" (SecuritySection), and "Oracle-Verified Execution" (DifferentiationSection) all overlap.

**Objective:** Cut the page length by approximately 40% while preserving all unique content. The user should never see more than ~100px of empty space between content blocks.

**Requirements:**

1. **Reduce section padding** across all sections in `LandingPage.tsx`:
   - Hero (`py-28 pt-28 pb-16`): keep as-is (hero needs breathing room)
   - All other sections: change `py-28` to `py-16` (from 112px to 64px each side)
   
2. **Lower animation thresholds** — all `viewport={{ once: true, amount: 0.3 }}` → `viewport={{ once: true, amount: 0.1 }}`. Grep for `amount:` in LandingPage.tsx and reduce every instance to 0.1. Content should be visible the moment its top edge enters the viewport, not when 30% is showing.

3. **Reduce animation delays** — the `SevenLayerSection` stagger and `SecuritySection` delays should be tightened:
   - `staggerChildren: 0.08` (line 23) is fine — keep it
   - Any `delay:` values above 0.3s should be reduced to 0.2s max
   - The trust strip `setTimeout` in HeroSection (line 78: `2000ms`) → reduce to `800ms`

4. **Merge SevenLayerSection into SecuritySection** — the 7-layer pipeline list (lines 381–530) and the security stats section (lines 591–707) should become ONE section called "Security". Move the most important pipeline items (Chainlink Oracle Check, Post-Execution Validation) as bullet points inside the SecuritySection, then DELETE the `SevenLayerSection` function entirely. Update the nav link in `Header.tsx` if it references `#seven-layer`.

5. **Remove the BottomCTASection's `min-h-screen`** (line 948) — change to just a normal section height. A CTA does not need a full viewport.

**Do NOT:**
- Remove any unique content — only merge duplicates
- Change the order of remaining sections: Hero → Performance → Differentiation → Security → Experience → Features → Roadmap → CTA
- Remove animations entirely — just make them faster and trigger earlier
- Touch the hero section's spacing (it's correct)

**Files affected:**
- `src/components/LandingPage.tsx` — section padding, animation thresholds, merge SevenLayer into Security, remove BottomCTA min-h-screen
- `src/components/Header.tsx` — update nav anchor if `#seven-layer` is referenced

**Expected output:** One commit. The page is approximately 40% shorter. Scrolling from top to bottom is a continuous flow of content with no empty viewports. Every scroll reveals new information within 300ms.

**Quality criteria:**
- No viewport-sized empty gaps between content
- All unique content preserved (nothing lost, only duplicates merged)
- Animations trigger when element top enters viewport (not when 30% visible)
- No animation delay >300ms except the hero entrance sequence
- Nav links still work correctly

---

## Prompt 72 — Establish feature card hierarchy

**Status:** Pending

**Context:** The Sprint 27 brief said: "Core differentiators (Meta-Aggregator, Oracle Verification, MEV Protection) should be visually elevated — larger, more prominent, or in a hero-style layout. Coming Soon features should be clearly secondary." Currently:

- `DifferentiationSection` (lines 535–585) has 3 cards: Meta-Aggregator, Oracle-Verified Execution, Post-Execution Proof. These are styled identically to all other cards. Also, "Post-Execution Proof" is not one of the 3 core differentiators from the brief — MEV Protection is.
- `FeaturesSection` (lines 879–940) has 12 cards in a flat 3-column grid. Coming Soon cards (`comingSoon: true`) have a tiny amber badge but are otherwise identical in size and prominence to live features.

**Objective:** Create clear visual hierarchy: 3 hero-level differentiators (prominent) → live features (normal) → coming soon (secondary/muted).

**Requirements:**

1. **Fix DifferentiationSection cards** (lines 536–551):
   - Replace "Post-Execution Proof" with "Active MEV Protection" (desc: "Intent-based execution powered by CoW Protocol batch auctions — solvers compete to give you the best outcome. Zero front-running, zero sandwich attacks."). Use a shield icon.
   - The 3 cards should now be: Meta-Aggregator, Oracle-Verified Execution, Active MEV Protection.

2. **Elevate DifferentiationSection visually:**
   - Add a gold left border to each card: `border-l-2 border-l-[#C8B89A]` (replacing the current `border-cream-08` on left side only)
   - Increase card padding: `p-6` → `p-8`
   - Add a subtle gold glow on hover: `hover:shadow-[0_0_30px_rgba(200,184,154,0.1)]`
   - Make titles larger: `text-lg` → `text-xl`

3. **Demote Coming Soon cards in FeaturesSection:**
   - Cards with `comingSoon: true` should have: `opacity-60`, `border-dashed` instead of `border-solid`, no hover effect
   - Move the "Coming Soon" badge from inline to a ribbon/overlay style at the top-right corner of the card
   - Group the Coming Soon cards at the END of the grid (they should be the last 3 cards, not interspersed)

4. **Remove duplicates from FeaturesSection** — the card "Active MEV Protection" already appears in DifferentiationSection after step 1. Remove it from the FEATURES array (line 826) to avoid repetition. Same for any content that overlaps with the 3 hero differentiators.

**Do NOT:**
- Change the DifferentiationSection headline ("What Makes TeraSwap Different")
- Remove any Coming Soon features — just visually demote them
- Add new features that don't exist in the current code
- Change the FeaturesSection headline ("Engineered for the Ethereum Elite")

**Files affected:**
- `src/components/LandingPage.tsx` — `DifferentiationSection` (lines 535–585) and `FeaturesSection` (lines 820–940)

**Expected output:** One commit. The 3 core differentiators are visually prominent with gold accents. Live features are standard cards. Coming Soon features are clearly secondary (muted, dashed borders, grouped at bottom). No duplicate content between sections.

**Quality criteria:**
- Visual hierarchy immediately obvious: gold-accented hero cards > solid feature cards > muted coming-soon cards
- No content duplication between DifferentiationSection and FeaturesSection
- Coming Soon cards grouped at the end, not mixed with live features
- All cards still responsive on mobile

---

## Prompt 73 — Move swap preview above the fold

**Status:** Pending

**Context:** The Sprint 27 brief said: "Add a screenshot, mockup, or interactive preview of the trading experience. Show, don't just tell." A swap widget mockup DOES exist in `ExperienceSection` (lines 768–811) — it shows a mock swap of 0.5 ETH → 994.68 USDC via Velora with a 0.1% fee. But it's buried in section 5 of 7, invisible until deep scrolling. The brief references (Jupiter, CoW, Aave) all show the product prominently — Jupiter shows the swap UI immediately.

**Objective:** Move the swap widget preview to a prominent position early in the page, so users see what the product looks like before scrolling past the first section.

**Requirements:**

1. **Extract the swap widget mockup** from `ExperienceSection` (lines 768–811) into a standalone component: `SwapPreview`. Keep all the current mock data (0.5 ETH → 994.68 USDC, Velora, 0.1% fee).

2. **Place `SwapPreview` in the HeroSection** — position it to the right of the headline on desktop (`lg:grid-cols-2`), below the headline on mobile. The hero layout changes from centered single-column to a two-column layout on `lg+`:
   - Left column: headline + subtitle + CTA + stats + trust strip (existing content)
   - Right column: `SwapPreview` component with a slight float/parallax effect

3. **Simplify the ExperienceSection** — since the swap preview moved to the hero, the Experience section should keep its text content (Zero Friction, Permit2 explanation) but remove the widget mockup div. Replace it with a simple "Launch the full app →" CTA that fills the right column, or make it a single-column text section.

4. **Add interactivity to SwapPreview** — make the "Swap" button in the preview actually call `onLaunchApp()` to navigate to the real swap interface. Add a subtle tooltip or label: "Try it live →".

5. **Hero layout responsive behavior:**
   - `lg+` (≥1024px): 2-column grid, headline left, preview right
   - `md` (768–1023px): preview below headline, max-width 380px, centered
   - `sm` and below: preview below headline, full-width with slight margin

**Do NOT:**
- Change the mock data in the swap preview (keep 0.5 ETH → USDC)
- Make the preview functional (no real swap logic) — it's a static mockup with a CTA
- Remove the ExperienceSection entirely — keep its text content about Permit2
- Add any new API calls or data fetching

**Files affected:**
- `src/components/LandingPage.tsx` — extract SwapPreview, modify HeroSection layout, simplify ExperienceSection

**Expected output:** One commit. The swap widget mockup is visible above the fold on desktop (right side of hero). Users immediately see what the product looks like. Clicking "Swap" on the preview navigates to the real app.

**Quality criteria:**
- Swap preview visible without scrolling on 1440px viewport
- Preview responsive and well-positioned at all breakpoints (375/768/1024/1440)
- No layout shift when preview loads (static content, no async data)
- ExperienceSection still renders correctly without the duplicate widget
- Clicking preview's Swap button navigates to the real swap interface

---

## Execution order

The prompts should be executed in order (69 → 73) because:
- P69 (counters) is independent and quick — ship first for immediate credibility fix
- P70 (backgrounds) is independent — visual continuity fix
- P71 (dead space) merges sections and changes layout — must be done before P72/P73 to avoid conflicts
- P72 (hierarchy) adjusts cards within the new layout from P71
- P73 (swap preview) restructures the hero — do last as it's the most complex layout change

Each prompt = 1 commit with hash recorded here after completion.
