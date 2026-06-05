# Sprint 27C — Landing Page Visual Polish

**Sprint window:** 2026-05-22 → TBD  
**Sprint goal:** Fix 4 visual issues found during Sprint 27B review. The page structure and content from 27B are correct — these are cosmetic/polish fixes only. Every prompt = 1 atomic commit.  
**Owner:** TeraHash (founder/architect) + code agent  
**Prerequisite:** Sprint 27B commits applied on branch `redesign/landing-page`.  
**Branch:** Continue on `redesign/landing-page`. Do NOT create a new branch.

**IMPORTANT:** This is a visual/UX-only sprint. Do NOT touch any files in `src/hooks/`, `src/lib/`, `src/app/api/`, or any contract/blockchain code.

> **Architect notes (2026-05-22):**
>
> 1. `bg-surface/80` silently fails. `surface.DEFAULT` is defined as hex `#080B10` in `tailwind.config.ts` (line 10). Tailwind's `/80` opacity modifier requires RGB channel format. The current classes compile to `background-color: rgb(8 11 16)` (fully opaque), which is why the background gets darker on scroll — sections have a solid `#080B10` layer painted on top of the particle canvas, blocking it entirely.
>
> 2. `ParticleNetwork.tsx` already supports mouse repulsion (`MOUSE_REPEL = 120px`) and scroll warp mode (`WARP_FORCE`, `WARP_SPEED_LIMIT`). But the effects are subtle. The user wants more obvious reactivity.
>
> 3. The `ExperienceSection` watermark text "cream-on-black" (line 735 of LandingPage.tsx) is visible at 3% opacity — it should be removed or hidden. It's a design token label, not marketing content.
>
> **Architect review (2026-05-22):**
>
> 4. **Line numbers are from the pre-sprint state.** After P74 and P75 modify `LandingPage.tsx`, all line references for P76 and P77 will be stale. Use **component/function names** as primary references (`SecuritySection`, `ExperienceSection`, `FeaturesSection`), not line numbers.
>
> 5. **P74 — use Option A only.** Do NOT touch `tailwind.config.ts`. Replace `bg-surface/80` with `bg-[rgba(8,11,16,0.82)]` directly. Other components depend on `bg-surface` without opacity modifier — changing the config risks breaking them.
>
> 6. **P77 — verify feature count.** Context says "8 live features" but the icon list has 9 entries. Confirm the actual count in the `FEATURES` array before adding icons — do not add an icon for a feature that doesn't exist.
>
> 7. **P76 requirement 2 — ignore the first instruction.** The prompt self-corrects mid-paragraph. Use only the final approach: keep `items-start` on the `<li>` and add `mt-1` to the badge element. Do NOT switch to `items-center`.

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| 74 | Fix background opacity + enhance particle reactivity | Replace broken bg-surface/80, boost particle mouse/scroll effects | ✅ DONE |
| 75 | Redesign differentiation cards | Upgrade from bordered boxes to premium hero-style cards | ✅ DONE |
| 76 | Fix security section alignment + cleanup | Badge/text alignment, remove watermark | ✅ DONE |
| 77 | Redesign features grid | Better visual treatment for the feature cards | ✅ DONE |
| 78 | Fix section background still too opaque | Lower rgba alpha + gradient fade transitions | Pending |

---

## Prompt 74 — Fix background opacity + enhance particle reactivity

**Status:** Pending

**Context:** Two related issues:

**Issue A — Background darkening on scroll.** All sections use `bg-surface/80` which was meant to give 80% opacity so particles bleed through. But `surface.DEFAULT` is defined as `#080B10` (hex) in `tailwind.config.ts` line 10. Tailwind's opacity modifier only works with CSS custom properties in RGB channel format (e.g., `--color-surface: 8 11 16`). Since it's hex, `/80` silently fails and the background renders as fully opaque `#080B10`. This makes every section after the hero look darker and flatter than the hero — the "cinematic continuity" is lost.

**Issue B — Particle reactivity.** `ParticleNetwork.tsx` already has mouse repulsion and scroll warp mode, but the effects are too subtle for users to notice. The user wants obvious visual feedback: particles reacting to cursor proximity and scroll velocity.

**Objective:** Make section backgrounds genuinely semi-transparent so particles show through, and boost particle interactivity so the whole page feels alive.

**Requirements:**

**Background fix (Issue A):**

1. In `tailwind.config.ts`, convert the `surface` color definitions from hex to Tailwind v4 CSS variable format so the `/80` modifier works. Two approaches — pick whichever is cleaner:

   **Option A (recommended):** Replace the section `bg-surface/80` classes in `LandingPage.tsx` with explicit rgba values that definitely work:
   - Replace every `bg-surface/80` with `bg-[rgba(8,11,16,0.82)]`
   - This avoids touching the Tailwind config (which other components depend on)
   
   **Option B:** Convert `surface.DEFAULT` in `tailwind.config.ts` from `'#080B10'` to a CSS custom property approach. Only do this if you can verify no other components break.

2. Verify after the change: open DevTools on any section element and confirm `background-color` shows an alpha value (e.g., `rgba(8, 11, 16, 0.82)`), NOT a solid `rgb(8, 11, 16)`.

3. Keep the hero section (`HeroSection`) with NO background — it should remain fully transparent so particles are most visible there.

**Particle reactivity (Issue B):**

4. In `ParticleNetwork.tsx`, increase these constants:
   - `MOUSE_REPEL`: `120` → `180` (larger repulsion radius)
   - `CURSOR_GLOW_RADIUS`: `250` → `350` (larger glow zone around cursor)
   - `MAX_LINE_OPACITY`: `0.35` → `0.55` (brighter lines near cursor)
   - `MAX_DOT_ALPHA_MULT`: `1.4` → `1.8` (brighter dots near cursor)

5. In the scroll warp mode, increase the effect intensity:
   - `WARP_FORCE`: `0.014` → `0.025` (stronger outward push)
   - `WARP_TRAIL_MAX`: `13` → `18` (longer trails during scroll)
   - `WARP_LERP_IN`: `0.14` → `0.22` (warp kicks in faster)
   - `WARP_LERP_OUT`: `0.02` → `0.04` (settles faster too, so it feels responsive not sluggish)

6. Do NOT change `PARTICLE_COUNT`, base colors, or the turbo mode (swap transaction animation).

**Do NOT:**
- Change the particle canvas z-index (keep it at current z value — z-0 or z-30, whichever it is after 27B)
- Add new dependencies or animation libraries
- Change `backdrop-blur` values on sections (those are fine)
- Touch any section content — only className background values

**Files affected:**
- `src/components/LandingPage.tsx` — replace all `bg-surface/80` with `bg-[rgba(8,11,16,0.82)]`
- `src/components/ParticleNetwork.tsx` — adjust 8 constants (listed above)
- `tailwind.config.ts` — only if using Option B

**Expected output:** One commit. Scrolling from hero through all sections shows particles subtly bleeding through every section background. Moving the mouse creates a visible glow zone that brightens nearby particles and lines. Scrolling creates a momentary "warp" burst where particles fly outward with trails.

**Quality criteria:**
- DevTools confirms `rgba` with alpha < 1 on section backgrounds
- Particle glow clearly visible when moving cursor across any section
- Scroll warp visually noticeable (not just on hero)
- Content text remains fully readable
- Lighthouse Performance ≥ 90

---

## Prompt 75 — Redesign differentiation cards

**Status:** Pending

**Context:** The `DifferentiationSection` currently shows 3 cards (Meta-Aggregator, Oracle-Verified Execution, Active MEV Protection) as bordered boxes with small icons, gold left border, and standard card styling. The user feedback: "não gosto dessas caixas" — they don't like the boxes. These are the 3 core differentiators and need to feel premium and distinctive, not like generic info cards.

Reference: Jupiter's feature section uses large icons with gradient backgrounds, bold typography, and each feature gets visual breathing room. CoW Protocol uses full-width alternating layouts for key features.

**Objective:** Redesign the 3 differentiation cards from generic bordered boxes to premium, visually distinct hero-style feature blocks that immediately communicate "these are the 3 things that make us different."

**Requirements:**

1. **Change layout from 3-column grid to stacked full-width blocks.** Each differentiator gets its own full-width row with a 2-column layout on desktop: icon/visual on one side, text on the other. Alternate the icon position (left-right-left) for visual rhythm. On mobile, stack vertically.

2. **Upgrade icons to large visual elements.** Replace the small 24px SVG icons with larger (80–120px) visual treatments:
   - **Meta-Aggregator:** Animated or styled SVG showing a central hub with 11 radiating connection lines (simplified version of the AdapterConstellation concept). Use gold stroke with subtle pulse animation.
   - **Oracle-Verified Execution:** A shield icon with a checkmark and the Chainlink logo/text inside. Gold stroke, same style.
   - **Active MEV Protection:** A shield with a crossed-out bot/sandwich icon inside. Conveys "protection from MEV bots".

3. **Typography upgrade:**
   - Title: `text-2xl sm:text-3xl font-bold text-cream` (larger than current `text-xl`)
   - Description: `text-[16px] leading-relaxed text-cream-75` (same as section body text)
   - Add a gold accent number before each title: "01", "02", "03" in `text-sm font-mono text-cream-gold tracking-wider` style (like the old SevenLayerSection numbers)

4. **Remove the card border entirely.** These should NOT look like cards. Each block is a clean content row separated by subtle horizontal dividers (`border-b border-cream-08`), not boxed elements.

5. **Keep the section headline** "What Makes TeraSwap Different" — just make it left-aligned instead of centered.

6. **Animation:** Each block fades in as it enters the viewport, with a 0.1 threshold. Icon animates with a subtle draw-in or scale effect. Text fades up. Keep total animation under 300ms.

**Do NOT:**
- Change the copy text for any differentiator (titles and descriptions stay the same)
- Add new npm dependencies
- Touch any other section
- Make the icons overly complex — they should be clean SVG, not illustrations

**Files affected:**
- `src/components/LandingPage.tsx` — `DifferentiationSection` function + associated icon components (`DiffNodesIcon`, `DiffShieldCheckIcon`, `DiffVerifiedDocIcon`)

**Expected output:** One commit. The 3 differentiators are presented as full-width stacked feature blocks with large icons, alternating layout, and numbered gold accents. Feels premium, not templated.

**Quality criteria:**
- Each differentiator visually distinct from generic feature cards
- Icons are at least 80px and styled consistently (gold stroke on dark)
- Layout alternates icon position on desktop (left-right-left)
- Mobile: stacks cleanly with icon above text
- No card borders — clean rows with subtle dividers

---

## Prompt 76 — Fix security section alignment + cleanup

**Status:** Pending

**Context:** Three issues in the Security section and Experience section:

1. **PRE-SWAP / POST-SWAP badge alignment.** In the security pipeline items (lines 666–693 of LandingPage.tsx), the badges use `rounded-full px-2 py-0.5` which causes "POST-SWAP" to wrap to two lines because the text is longer than "PRE-SWAP". The badge breaks the horizontal alignment with the title text next to it.

2. **Stats box text alignment.** The 3 stat boxes (7 validation layers, 29 oracle feeds, ✓ post-execution) have centered text but the labels are different lengths, creating visual unevenness.

3. **"cream-on-black" watermark.** The Experience section (line 730–737) has a background watermark element that renders "cream-on-black" in giant text at 3% opacity. This is a design token label from the Hallmark template, not actual content. It's visible on scroll and looks like a bug.

**Objective:** Fix the alignment issues and remove the watermark.

**Requirements:**

1. **Fix badge sizing.** Change the PRE-SWAP and POST-SWAP badge elements (lines 667–672 and 681–686) from `rounded-full px-2 py-0.5` to a fixed-width approach:
   - Use `inline-flex items-center justify-center min-w-[80px] rounded px-2 py-1 text-[9px] font-bold tracking-[0.06em] whitespace-nowrap` 
   - Both badges should be the same width so they align vertically in the list
   - Change from `rounded-full` (pill shape) to `rounded` (subtle corner radius) — pill shape doesn't work well with multi-word labels
   - Add `flex-shrink-0` to prevent the badge from compressing

2. **Fix pipeline item alignment.** The `<li>` elements use `flex items-start gap-3`. Change to `flex items-center gap-4` so the badge vertically centers with the title line. The description text should wrap below naturally.

   Actually — better approach: keep `items-start` but change the badge to `mt-1` instead of `mt-0.5` so it aligns better with the first line of the title.

3. **Fix stat box consistency.** The 3 stat boxes (lines 697–716) are fine structurally but the "✓" text value (for "Post-execution verified") looks smaller than the numbers. Increase the `✓` text size or replace with a more prominent check: use `✓ Verified` as the display text instead of just `✓`, at the same `text-3xl` size as the numbers.

4. **Remove the watermark.** Delete the entire `div` block at lines 729–737 of `LandingPage.tsx` (the "cream-on-black" watermark in `ExperienceSection`). It's not content — it's a Hallmark template artifact.

**Do NOT:**
- Change the security section's text content or structure
- Alter the stats values (7, 29)
- Remove or reorder sections
- Touch the shield SVG animation

**Files affected:**
- `src/components/LandingPage.tsx` — `SecuritySection` (badge + stat fixes), `ExperienceSection` (remove watermark div)

**Expected output:** One commit. PRE-SWAP and POST-SWAP badges are equal width and properly aligned. Stat boxes look consistent. "cream-on-black" watermark is gone.

**Quality criteria:**
- Both badges render on a single line, same width
- Badge + title are visually aligned on the same baseline
- "✓ Verified" in stats is same visual weight as "7" and "29"
- No trace of "cream-on-black" text anywhere on the page
- Mobile: badges and stats still render correctly

---

## Prompt 77 — Redesign features grid

**Status:** Pending

**Context:** The `FeaturesSection` shows 8 live features as identical cards in a 3-column grid with a gold separator line inside each. The user feedback is that the presentation is boring and the cards look generic. The current styling is: `rounded-2xl border border-cream-08 bg-surface-secondary p-7` with an 8px gold line separator and standard text.

The problem is visual monotony — 8 identical rectangles in a grid doesn't communicate value hierarchy or invite exploration. Jupiter uses icon-led cards with hover states. Aave uses metric-driven cards. CoW uses alternating layouts.

**Objective:** Make the features grid visually engaging while maintaining scannability.

**Requirements:**

1. **Add icons to each feature card.** Define a simple SVG icon (24–32px, gold stroke, no fill) for each feature. Map them in the `FEATURES` array:
   - 11 Liquidity Sources → network/nodes icon (3 connected dots)
   - Gas-Aware Routing → gas pump or calculator icon
   - Statistical Outlier Detection → chart with alert icon
   - Multi-Oracle Price Protection → shield with link icon
   - Privacy-First Architecture → eye-slash or lock icon
   - Split Routing → fork/split arrows icon
   - Analytics Dashboard → bar chart icon
   - Gasless Approvals → signature/pen icon
   - Active Approvals Manager → key/revoke icon
   
   Position icon above the title in each card.

2. **Improve card hover state.** Current hover only changes border color. Enhance to:
   - Border transitions to gold: `hover:border-[#C8B89A]`
   - Subtle upward lift: `hover:-translate-y-1`
   - Background lightens slightly: `hover:bg-surface-tertiary`
   - Icon scales up: wrap icon in a div with `transition-transform group-hover:scale-110`
   - Transition duration: `duration-200`

3. **Remove the gold separator line** inside each card (the `<div className="mb-3 h-px w-8" style={{ background: '#C8B89A' }} />`). Replace with spacing only — the icon already provides visual separation between header and body.

4. **Adjust card padding and spacing.** Current `p-7` is generous. Change to `p-5 sm:p-6` for tighter but comfortable spacing. Grid gap: `gap-3 sm:gap-4` (tighter than current `gap-4 lg:gap-5`).

5. **Add `group` class to each card div** so child elements can use `group-hover:` utilities.

6. **Keep the Roadmap subsection as-is** — the dashed border + opacity treatment for Coming Soon cards is correct. Only change the live feature cards.

**Do NOT:**
- Change feature titles or descriptions
- Reorder features
- Touch the Roadmap/Coming Soon subsection
- Add external icon libraries — use inline SVG
- Make cards clickable/linkable (they're informational only)

**Files affected:**
- `src/components/LandingPage.tsx` — `FEATURES` array (add icon field) and `FeaturesSection` function (card rendering)

**Expected output:** One commit. Feature cards have gold-stroke icons above titles, engaging hover states with lift + glow, and tighter spacing. Grid feels curated, not templated.

**Quality criteria:**
- Every live feature card has a unique icon
- Icons are consistent style: 24–32px, gold stroke (#C8B89A), no fill, 1.5px stroke-width
- Hover state is visually obvious but not distracting (lift + border + bg change)
- Grid is responsive: 1 col on mobile, 2 on tablet, 3 on desktop
- No gold separator lines inside cards

---

## Prompt 78 — Fix section background still too opaque

**Status:** Pending

**Context:** P74 replaced `bg-surface/80` with `bg-[rgba(8,11,16,0.82)]` and boosted particle constants. The particle reactivity is good now (mouse glow, scroll warp work). But the section backgrounds are still visually indistinguishable from fully opaque. The math explains why: `rgba(8,11,16,0.82)` means 82% of an almost-black colour — the 18% transparency allows at most ~3 luminance units through on a black canvas. That's imperceptible.

The user's screenshot shows a sharp visual "wall" at the boundary between the hero (transparent, particles visible) and the first section (near-opaque, particles invisible). The page should feel like one continuous environment.

**Objective:** Make particles genuinely visible through section backgrounds, and smooth the hero → section transition so there's no hard edge.

**Requirements:**

1. **Lower section background opacity.** In `LandingPage.tsx`, replace all instances of `bg-[rgba(8,11,16,0.82)]` with `bg-[rgba(8,11,16,0.55)]`. This gives 55% opacity — enough to keep text readable (dark text sections on dark canvas) while letting the particle glow and connection lines bleed through noticeably.

   Sections to change (find by searching for `bg-[rgba(8,11,16,0.82)]`):
   - `PerformanceSection`
   - `DifferentiationSection` (or whatever it's called after P75)
   - `SecuritySection`
   - `ExperienceSection`
   - `FeaturesSection`
   - `BottomCTASection`

2. **Add gradient fade at the top of the first section after the hero.** The hero has NO background → the first section has 55% opacity. Even at 55%, there will be a visible edge. Add a gradient overlay `div` at the TOP of `PerformanceSection` (or whichever section comes right after the hero):

   ```jsx
   {/* Gradient transition from hero (transparent) to section bg */}
   <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-transparent to-[rgba(8,11,16,0.55)]" />
   ```

   This creates a 128px smooth fade from the hero's transparent background into the section's semi-transparent one. The section needs `position: relative` (already has it via `relative` class) for the absolute positioning to work.

3. **Increase base particle brightness** so they're visible even through 55% overlay. In `ParticleNetwork.tsx`, adjust these two constants:
   - `BASE_LINE_OPACITY`: current value → increase by 0.05 (find current value and add 0.05)
   - `BASE_DOT_ALPHA_MULT`: current value → increase by 0.2 (find current value and add 0.2)

   These are the BASELINE brightness (without cursor proximity). They need to be bright enough that particles are faintly visible in every section, not just near the cursor.

4. **Test the visual result.** After applying changes, scroll slowly from hero to the first section. The particles should:
   - Be clearly visible in the hero (no background)
   - Fade smoothly into the first section (gradient transition)
   - Remain faintly visible in all sections (55% overlay)
   - Brighten noticeably near the cursor in any section (cursor glow)

5. **If 55% is too transparent** and text readability suffers (unlikely since base colors are 8,11,16 on a black canvas, and text is cream), try `0.60` as a fallback. But do NOT go above `0.70` — that's the range where particles become invisible again.

**Do NOT:**
- Change section content, structure, or padding
- Add `backdrop-blur` to sections that don't already have it
- Change the particle canvas z-index
- Touch the hero section background (keep it transparent)
- Change the cursor glow or warp constants from P74 (those are fine)

**Files affected:**
- `src/components/LandingPage.tsx` — replace all `bg-[rgba(8,11,16,0.82)]` with `bg-[rgba(8,11,16,0.55)]` + add gradient div to first section after hero
- `src/components/ParticleNetwork.tsx` — increase `BASE_LINE_OPACITY` by 0.05 and `BASE_DOT_ALPHA_MULT` by 0.2

**Expected output:** One commit. Scrolling from hero through all sections shows a smooth transition and particles subtly visible everywhere. No sharp "wall" between hero and content.

**Quality criteria:**
- No visible hard edge between hero and first section
- Particles (dots and connection lines) faintly visible in every section without cursor proximity
- Particles clearly visible near cursor in every section
- All text remains fully readable (WCAG AA)
- Lighthouse Performance ≥ 90

---

## Execution order

P74 → P75 → P76 → P77 → P78 (sequential)

- P74–P77: ✅ DONE
- P78: fixes the remaining opacity issue from P74

Each prompt = 1 commit with hash recorded here after completion.
