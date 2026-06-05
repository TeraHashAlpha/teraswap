# Sprint 28 — Cinematic Landing Page (Hubtown-Inspired)

**Sprint window:** 2026-05-25 → TBD  
**Sprint goal:** Transform the landing page from a sectioned layout into a seamless cinematic experience. Inspired by Hubtown (hubtown.co.in) — a full WebGL scroll-driven 3D site — but adapted to TeraSwap's existing React/Canvas stack. No Three.js, no scroll-jacking, no new heavy dependencies. Five prompts that progressively layer visual continuity, particle evolution, flow lines, text animation, and scroll navigation.  
**Owner:** TeraHash (founder/architect) + code agent  
**Prerequisite:** Sprint 27C fully merged (P74–P78 in production, PR #81 commit 6c9f9be). All section backgrounds currently at `bg-[rgba(8,11,16,0.55)]` with gradient fade div on PerformanceSection (P78 — commit 934c9cc).  
**Branch:** Create new branch `redesign/cinematic-landing` from `main`. Do NOT reuse `redesign/landing-page` (already merged).

**IMPORTANT:** This is a visual/animation-only sprint. Do NOT touch any files in `src/hooks/`, `src/lib/`, `src/app/api/`, or any contract/blockchain code.

> **Architect notes (2026-05-25):**
>
> 1. **Hubtown uses Three.js/WebGL.** We are NOT adding Three.js. All effects are implemented via: (a) the existing 2D canvas in `ParticleNetwork.tsx`, (b) Framer Motion in `LandingPage.tsx`, (c) a new small component for ScrollSpy. Total new dependency count: 0.
>
> 2. **Performance budget.** Particle count stays at 110 desktop / 55 mobile. The flow lines (P86) add O(n) draws per frame (not O(n²) like connections). Target: Lighthouse Performance ≥ 85 on desktop.
>
> 3. **Line numbers are from the state AFTER Sprint 27C (P74–P78).** P84 modifies LandingPage.tsx first, so all subsequent prompts should use **component/function names** as primary references, not line numbers.
>
> 4. **Text readability is non-negotiable.** Every prompt has a readability check. If particles underneath a heading make it unreadable, the Code Agent must add `text-shadow` or a localised backdrop-blur. Do NOT revert to opaque backgrounds — find a per-element solution.
>
> 5. **Execution order matters.** P84 → P85 → P86 → P87 → P88 (sequential). P85 and P86 both modify ParticleNetwork.tsx — P85 adds the scroll-progress system, P86 builds on it for flow lines.
>
> 6. **Architect review R1 rejected.** The suggestion to keep `bg-[rgba(8,11,16,0.12)]` as a "safety net" was rejected because the math shows it provides zero meaningful contrast: 12% opacity of rgb(8,11,16) over a black canvas = rgb(1,1,2) — 1 luminance unit. Indistinguishable from transparent. The actual readability mechanism is `text-shadow` with a 30px dark halo (~200+ luminance units of contrast). That's what guarantees WCAG AA, not a sub-perceptual background overlay.
>
> 7. **Architect review R3 rejected.** The claim that flow line coordinates need scroll-height awareness is factually incorrect. The canvas is `position: fixed; inset: 0` with `W = window.innerWidth, H = window.innerHeight`. It covers the **viewport**, not the full page scroll height. Coordinates (0–1) × (W, H) map correctly to the visible area regardless of scroll position. No correction needed.

---

## Sprint status table

| # | Prompt | Description | Status |
|---|--------|------------|--------|
| 84 | Kill section backgrounds | Remove section bg, add text-shadow readability, per-element glass | Pending |
| 85 | Scroll-linked particle evolution | Particles change behaviour based on scroll position (0→1) | Pending |
| 86 | Canvas flow lines | Animated bezier curves with gold pulse dots | Pending |
| 87 | SplitText letter reveals | Character-by-character headline animations | Pending |
| 88 | ScrollSpy dot navigation | Fixed left sidebar with section indicators | Pending |

---

## Prompt 84 — Kill section backgrounds

**Status:** Pending

**Context:** The landing page currently has `bg-[rgba(8,11,16,0.55)]` on every section after the hero (applied by P78, commit 934c9cc). There is also a gradient fade div at the top of PerformanceSection (also from P78). Even at 55% opacity, this near-black overlay makes the particle canvas almost invisible in content sections — the math: 55% of rgb(8,11,16) over black = rgb(4,6,9), which is perceptually identical to solid black.

The Hubtown reference has ZERO section backgrounds — content floats directly over the 3D canvas with only localised blur on interactive elements. P84 removes section backgrounds entirely and uses text-shadow as the primary readability mechanism.

**Objective:** Remove opaque section wrappers so the particle canvas is visible across the entire page. Use text-shadow and localised backdrop-blur on individual elements for readability.

**Requirements:**

1. **Remove section background classes.** In `LandingPage.tsx`, for each of these sections, remove the `bg-[rgba(8,11,16,0.55)]` class and any `backdrop-blur-[1px]` from the `<section>` element:
   - `PerformanceSection`: remove `bg-[rgba(8,11,16,0.55)] backdrop-blur-[1px]`
   - `DifferentiationSection`: remove `bg-[rgba(8,11,16,0.55)]`
   - `SecuritySection`: remove `bg-[rgba(8,11,16,0.55)]`
   - `ExperienceSection`: remove `bg-[rgba(8,11,16,0.55)]`
   - `FeaturesSection`: remove `bg-[rgba(8,11,16,0.55)] backdrop-blur-[1px]`
   - `BottomCTASection`: remove `bg-[rgba(8,11,16,0.55)]`

   The `<section>` elements keep their `relative`, `py-16`, `px-6` and `id` attributes — only the background/blur classes are removed.

2. **Remove the gradient transition div** at the top of `PerformanceSection` (added by P78). It's the `<div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-transparent to-[rgba(8,11,16,0.55)]" />` element. With no section background at all, there's nothing to fade into.

3. **Add text-shadow to all section headlines** for readability over particles. In the `SectionHeadline` component, add an inline style:
   ```tsx
   style={{ textShadow: '0 0 30px rgba(8,11,16,0.9), 0 0 60px rgba(8,11,16,0.6)' }}
   ```
   This creates a dark halo behind headline text without adding a visible box. Apply the same text-shadow to the hero H1.

4. **Add text-shadow to body paragraphs.** Every `<p>` with `text-cream-75` or `text-cream-50` in section content needs a subtler shadow. Add inline style:
   ```
   style={{ textShadow: '0 0 20px rgba(8,11,16,0.8), 0 0 40px rgba(8,11,16,0.5)' }}
   ```

5. **Add glass effect to interactive cards.** The following card-like elements need a semi-transparent background + backdrop-blur to remain readable:
   - **Feature cards** in `FeaturesSection`: change class to `bg-surface-secondary/80 backdrop-blur-md`
   - **Roadmap cards** in `FeaturesSection`: keep existing `bg-surface-secondary/50` and add `backdrop-blur-sm`
   - **Security pipeline items** (PRE-SWAP / POST-SWAP li elements): keep `bg-surface-secondary/60` and add `backdrop-blur-sm`
   - **Security stat boxes**: keep `bg-surface-secondary` and add `backdrop-blur-md`
   - **SwapPreview card** in hero: keep its existing `bg-surface-secondary` — it already has enough contrast
   - **AdapterConstellation** mobile list items: keep `bg-surface-secondary` — small elements, already fine

6. **Add a very subtle vignette** to the page to darken edges without blocking particles in the center. In `LandingPage.tsx`, add a fixed overlay as the FIRST child of the main wrapper `<div>`:
   ```tsx
   {/* Vignette — darkens edges for depth, center stays clear for particles */}
   <div 
     className="pointer-events-none fixed inset-0 z-[1]"
     style={{
       background: 'radial-gradient(ellipse at center, transparent 40%, rgba(8,11,16,0.4) 100%)'
     }}
   />
   ```

**Do NOT:**
- Add `bg-surface` or any background back to `<section>` wrappers — text-shadow is the readability mechanism
- Change the particle canvas z-index or positioning
- Remove any section content, IDs, or structural elements
- Touch `ParticleNetwork.tsx` (that's P85)
- Change the SwapPreview or AdapterConstellation styling

**Files affected:**
- `src/components/LandingPage.tsx` — remove 6 section backgrounds, remove gradient div, add text-shadows, add backdrop-blur to cards, add vignette

**Expected output:** One commit. Scrolling from hero through all sections shows particles visible across the ENTIRE page. Headlines have dark halos for readability. Cards have a frosted glass effect. The page feels like one continuous environment, not a series of boxed sections.

**Quality criteria:**
- No `bg-[rgba(8,11,16` on any `<section>` element (verify in DevTools)
- Particles visible behind every section (connection lines, dots, cursor glow all work)
- All text passes WCAG AA contrast (text-shadow provides the contrast layer)
- Feature cards, security stats, and pipeline items remain fully readable
- Mobile: same transparent treatment, cards still readable
- Lighthouse Performance ≥ 85

---

## Prompt 85 — Scroll-linked particle evolution

**Status:** Pending

**Context:** The ParticleNetwork currently has 3 modes: calm (default), warp (scroll-velocity-driven burst), and turbo (swap transaction). But the particles look the same regardless of where the user is on the page. The Hubtown reference changes the entire visual scene as the user scrolls through sections — different camera angles, different 3D scenes, different energy patterns.

We can't do 3D camera work, but we CAN make the particle system evolve as the user scrolls down the page. The scroll position (0 = top, 1 = bottom) becomes a continuous input that modifies particle behaviour: density of connections, movement patterns, and brightness.

**Objective:** Add scroll-progress awareness to ParticleNetwork so particles visually evolve from top to bottom of the page, creating a sense of journey.

**Requirements:**

1. **Add scroll progress tracking.** In `ParticleNetwork.tsx`, add a new ref alongside the existing refs (line ~69):
   ```tsx
   const scrollProgressRef = useRef(0) // 0 = top of page, 1 = bottom
   ```
   
   In the existing `onScroll` handler (line ~296), add scroll progress calculation after the existing warp logic:
   ```tsx
   function onScroll() {
     // Existing warp logic (keep as-is)
     warpTargetRef.current = 1
     clearTimeout(scrollTimer)
     scrollTimer = setTimeout(() => { warpTargetRef.current = 0 }, 160)
     
     // NEW: normalised scroll progress (0→1)
     const maxScroll = document.documentElement.scrollHeight - window.innerHeight
     scrollProgressRef.current = maxScroll > 0 ? window.scrollY / maxScroll : 0
   }
   ```

2. **Scroll-driven connection distance.** In the `draw()` function, read scroll progress early and modify `maxDist`:
   ```tsx
   const sp = scrollProgressRef.current
   // Base maxDist grows from 160 (top) to 220 (bottom) — denser network as you scroll
   const scrollMaxDist = MAX_DIST + sp * 60
   const maxDist = scrollMaxDist + (TURBO_MAX_DIST - scrollMaxDist) * t
   ```
   This makes the particle network feel denser and more connected in lower sections.

3. **Scroll-driven base brightness.** Particles get subtly brighter as the user scrolls down:
   ```tsx
   const scrollBrightBoost = sp * 0.15
   const baseLineOp = (BASE_LINE_OPACITY + scrollBrightBoost) + (TURBO_LINE_OPACITY - BASE_LINE_OPACITY) * t
   const baseDotMult = (BASE_DOT_ALPHA_MULT + sp * 0.3) + (TURBO_DOT_ALPHA_MULT - BASE_DOT_ALPHA_MULT) * t
   ```

4. **Scroll-driven particle drift direction.** Add a subtle downward bias as the user scrolls, simulating gravitational pull:
   ```tsx
   // In the position update loop, after existing warp/turbo logic:
   if (sp > 0.1 && w < 0.1 && t < 0.1) {
     p.vy += sp * 0.003
   }
   ```

5. **Scroll-driven line width.** Connection lines get slightly thicker at the bottom:
   ```tsx
   ctx!.lineWidth = (0.5 + sp * 0.3) + cursorFactor * 0.5 + t * 1.2
   ```

6. **Do NOT change particle count, base colours, the warp system, the turbo system, or the mouse interaction.** This is additive — it modifies existing parameters. When turbo or warp are active, they override the scroll-driven values.

**Do NOT:**
- Change `PARTICLE_COUNT`
- Add new particle types or layers
- Modify the canvas element or its CSS
- Change the turbo mode or warp mode logic
- Touch `LandingPage.tsx`

**Files affected:**
- `src/components/ParticleNetwork.tsx` — add scrollProgressRef, modify draw() to use scroll-driven parameters

**Expected output:** One commit. Scrolling slowly from top to bottom, the particle network visually evolves: sparse and calm at the hero, denser and brighter connections in middle sections, slightly flowing downward near the bottom. The effect is subtle — a careful observer notices it, a casual user just feels "the page is alive."

**Quality criteria:**
- Scroll progress correctly normalised (0 at top, ~1 at bottom)
- Network visibly denser at bottom vs top (compare screenshots)
- No performance regression: 60fps on desktop, 30fps+ on mobile
- Warp mode and turbo mode still work correctly
- Mouse glow still works in all scroll positions
- `prefers-reduced-motion` still disables animations

---

## Prompt 86 — Canvas flow lines

**Status:** Pending

**Context:** The Hubtown reference has dramatic glowing energy streams flowing across the screen — bezier curves with particles traveling along them. We can simulate this in 2D canvas by drawing animated quadratic bezier curves between fixed anchor points, with a moving "pulse" dot that travels along the curve. The curves use TeraSwap's gold colour (#C8B89A) with a fake-glow technique (concentric circles, NOT shadowBlur — per architect review R4).

**Objective:** Add 3 animated flow lines to the particle canvas that create ambient energy flow across the viewport, using gold colour with glow.

**Requirements:**

1. **Define flow line anchor points.** As a module-level constant OUTSIDE the component (to avoid re-allocation every frame):
   ```tsx
   const FLOW_LINES = [
     // Line 1: top-left to center-right, gentle S-curve
     { points: [[0.05, 0.3], [0.3, 0.15], [0.6, 0.4], [0.95, 0.25]], width: 1.2, speed: 0.0008 },
     // Line 2: left-center to bottom-right
     { points: [[0.0, 0.55], [0.25, 0.65], [0.55, 0.45], [0.85, 0.7]], width: 0.8, speed: 0.0012 },
     // Line 3: top-right to bottom-left, crossing the others
     { points: [[0.9, 0.1], [0.7, 0.35], [0.35, 0.55], [0.1, 0.85]], width: 1.0, speed: 0.001 },
   ]
   ```

   Coordinates are viewport-relative (0–1 range, multiplied by W/H at draw time). The canvas is `position: fixed; inset: 0` sized to the viewport — these coordinates map to the visible screen area correctly regardless of scroll position.

2. **Add the `interpolateCurve` helper function** at module level:
   ```tsx
   /** Interpolate position along a polyline at parameter t (0→1) */
   function interpolateCurve(pts: number[][], t: number): [number, number] {
     const totalSegments = pts.length - 1
     const segment = Math.min(Math.floor(t * totalSegments), totalSegments - 1)
     const localT = (t * totalSegments) - segment
     const x = pts[segment][0] + (pts[segment + 1][0] - pts[segment][0]) * localT
     const y = pts[segment][1] + (pts[segment + 1][1] - pts[segment][1]) * localT
     return [x, y]
   }
   ```

3. **Draw flow lines.** After the particle drawing code but before the position update code in `draw()`, add:
   ```tsx
   // ── Flow lines — ambient energy streams ──
   if (!PREFERS_REDUCED_MOTION) {
     const flowTime = Date.now()
     const goldColor = '200, 184, 154' // #C8B89A in RGB
     const flowFade = 1 - Math.max(w, t) // fade during warp/turbo
     
     if (flowFade > 0.1) {
       for (const flow of FLOW_LINES) {
         const pts = flow.points.map(([px, py]) => [px * W, py * H])
         
         // Draw the static line (very subtle)
         ctx!.beginPath()
         ctx!.moveTo(pts[0][0], pts[0][1])
         for (let i = 1; i < pts.length - 1; i++) {
           const xc = (pts[i][0] + pts[i + 1][0]) / 2
           const yc = (pts[i][1] + pts[i + 1][1]) / 2
           ctx!.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc)
         }
         ctx!.quadraticCurveTo(
           pts[pts.length - 2][0], pts[pts.length - 2][1],
           pts[pts.length - 1][0], pts[pts.length - 1][1]
         )
         ctx!.strokeStyle = `rgba(${goldColor}, ${(0.04 + sp * 0.03) * flowFade})`
         ctx!.lineWidth = flow.width
         ctx!.stroke()
         
         // Draw the traveling pulse dot — concentric circles (no shadowBlur)
         const progress = (flowTime * flow.speed) % 1
         const pos = interpolateCurve(pts, progress)
         const pulseAlpha = (0.5 + sp * 0.3) * flowFade
         
         // Outer glow (6px, 15% opacity)
         ctx!.beginPath()
         ctx!.arc(pos[0], pos[1], 6 + sp * 2, 0, Math.PI * 2)
         ctx!.fillStyle = `rgba(${goldColor}, ${pulseAlpha * 0.15})`
         ctx!.fill()
         // Mid glow (4px, 30% opacity)
         ctx!.beginPath()
         ctx!.arc(pos[0], pos[1], 4 + sp * 1.2, 0, Math.PI * 2)
         ctx!.fillStyle = `rgba(${goldColor}, ${pulseAlpha * 0.3})`
         ctx!.fill()
         // Core dot (2px, 60% opacity)
         ctx!.beginPath()
         ctx!.arc(pos[0], pos[1], 2 + sp * 0.5, 0, Math.PI * 2)
         ctx!.fillStyle = `rgba(${goldColor}, ${pulseAlpha * 0.6})`
         ctx!.fill()
       }
     }
   }
   ```

4. **Flow lines respond to scroll.** The `sp` (scroll progress from P85) controls flow line opacity and pulse brightness. At the top (sp=0), lines are barely visible (4% opacity). At the bottom (sp=1), they're slightly more prominent (7% opacity) with brighter pulses.

5. **Flow lines fade during warp and turbo.** The `flowFade = 1 - Math.max(w, t)` multiplier handles this. When warp or turbo is fully active, flow lines disappear.

**Do NOT:**
- Draw more than 5 flow lines (performance)
- Use `ctx.shadowBlur` — use concentric circles for glow (cheaper, same visual)
- Use `ctx.filter` or CSS filters
- Modify the existing particle drawing code
- Change `PARTICLE_COUNT` or particle behaviour

**Files affected:**
- `src/components/ParticleNetwork.tsx` — add FLOW_LINES constant, interpolateCurve helper, flow line drawing block in draw()

**Expected output:** One commit. Three gold energy lines arc subtly across the viewport. Each has a small glowing dot that travels along it continuously. The lines are barely visible normally but become slightly more prominent as the user scrolls down. During warp/turbo, they fade to let the particle effects take center stage.

**Quality criteria:**
- Flow lines are visible but SUBTLE — they should NOT dominate the visual field
- Gold colour matches the brand (#C8B89A)
- Pulse dots move smoothly along curves with visible glow (concentric circles)
- Lines fade during warp and turbo
- No performance regression: 60fps on desktop (no shadowBlur)
- `prefers-reduced-motion` skips flow lines entirely

---

## Prompt 87 — SplitText letter reveals

**Status:** Pending

**Context:** Hubtown animates every headline letter-by-letter with stagger, creating a dramatic reveal effect. TeraSwap's headlines currently use a simple `fadeInUp` variant (opacity 0→1, y 32→0) from Framer Motion. Upgrading to character-level animation adds cinema without significant performance cost.

Per architect review R2: CSS `filter: blur()` per character creates compositing layers. Use blur at 2px (not 4px) on desktop only. On mobile viewports (< 768px) or prefers-reduced-motion, skip blur entirely — use opacity + y only.

**Objective:** Create a `SplitText` component that wraps headline text and animates each character individually with Framer Motion. Apply it to the key section headlines.

**Requirements:**

1. **Create the SplitText component.** Add it to `LandingPage.tsx` in the animation utilities section (near the existing `SectionHeadline` component):

   ```tsx
   /** Splits text into individual characters, each animated with stagger.
    *  Uses Framer Motion variants — parent controls orchestration.
    *  Blur effect desktop-only (per architect review R2 — compositing cost). */
   function SplitText({ 
     children, 
     className = '',
     style,
   }: { 
     children: string
     className?: string
     style?: React.CSSProperties
   }) {
     const words = children.split(' ')
     const useBlur = !PREFERS_REDUCED_MOTION && !IS_MOBILE
     
     return (
       <motion.span
         initial="hidden"
         whileInView="visible"
         viewport={{ once: true, amount: 0.3 }}
         variants={{
           hidden: {},
           visible: { transition: { staggerChildren: 0.03 } },
         }}
         className={className}
         style={style}
         aria-label={children}
       >
         {words.map((word, wi) => (
           <span key={wi} className="inline-block whitespace-nowrap">
             {word.split('').map((char, ci) => (
               <motion.span
                 key={`${wi}-${ci}`}
                 className="inline-block"
                 variants={{
                   hidden: { 
                     opacity: 0, 
                     y: 20, 
                     ...(useBlur ? { filter: 'blur(2px)' } : {})
                   },
                   visible: { 
                     opacity: 1, 
                     y: 0, 
                     ...(useBlur ? { filter: 'blur(0px)' } : {}),
                     transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } 
                   },
                 }}
                 aria-hidden="true"
               >
                 {char}
               </motion.span>
             ))}
             {wi < words.length - 1 && <span className="inline-block">&nbsp;</span>}
           </span>
         ))}
       </motion.span>
     )
   }
   ```

   Note: `IS_MOBILE` and `PREFERS_REDUCED_MOTION` are already defined at module level in `ParticleNetwork.tsx`. For `LandingPage.tsx`, add equivalent checks at the top of the file:
   ```tsx
   const IS_MOBILE_VIEWPORT = typeof window !== 'undefined' && window.innerWidth < 768
   const PREFERS_REDUCED = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
   ```
   Then use these in the SplitText component.

2. **Apply SplitText to these headlines** (replace the current text content with a SplitText wrapper):

   - **Hero H1** (in `HeroSection`): Wrap "One swap. Eleven routes." in SplitText. Keep the "Verified." `<span className="text-shimmer">` separate:
     ```tsx
     <SplitText>One swap. Eleven routes.</SplitText>{' '}
     <span className="text-shimmer">Verified.</span>
     ```

   - **PerformanceSection headline**: 
     ```tsx
     <SplitText>Limitless Liquidity. Relentless Execution.</SplitText>
     ```

   - **DifferentiationSection headline**:
     ```tsx
     <SplitText>What Makes TeraSwap Different</SplitText>
     ```

   - **SecuritySection headline**:
     ```tsx
     <SplitText>Institutional-Grade Security.</SplitText>
     ```

   - **BottomCTASection headline**: Wrap the non-shimmer parts:
     ```tsx
     <SplitText>Don't leave</SplitText>{' '}
     <span className="text-shimmer">performance</span>{' '}
     <SplitText>on the table.</SplitText>
     ```

3. **Do NOT apply SplitText to:**
   - The ExperienceSection headline (already has custom 2-line stagger)
   - The FeaturesSection headline
   - Body paragraphs (too many characters = performance risk)

4. **Avoid double-animation.** For headlines that use SplitText, the wrapping `SectionHeadline` component should NOT apply its own `fadeInUp` variants. **Remove the `variants` prop from SectionHeadline** when it contains SplitText — let SplitText handle the entire reveal. Use whichever approach avoids two nested `whileInView` triggers fighting.

5. **Respect prefers-reduced-motion.** If enabled, SplitText renders all characters immediately (no stagger, no blur, no y offset). The `PREFERS_REDUCED` check handles this — when true, set initial state to `visible` directly.

**Do NOT:**
- Add external dependencies
- Apply SplitText to body text paragraphs
- Change existing animation timing on non-SplitText elements
- Break semantic HTML (SplitText must preserve text content for accessibility via `aria-label`)
- Use `filter: blur()` on mobile viewports (< 768px)

**Files affected:**
- `src/components/LandingPage.tsx` — add SplitText component, add IS_MOBILE_VIEWPORT/PREFERS_REDUCED constants, apply to 5 headlines

**Expected output:** One commit. Section headlines reveal character-by-character with a rise + optional blur-dissolve effect, staggered at 30ms per character. Total headline reveal takes ~500-800ms depending on character count. Blur effect only on desktop; mobile gets clean opacity+rise only.

**Quality criteria:**
- Characters animate individually with visible stagger
- Blur dissolve (2px→0) visible on desktop, skipped on mobile
- No double-animation (SectionHeadline + SplitText fighting)
- Accessibility: screen readers read the full text (aria-label on wrapper)
- prefers-reduced-motion: instant render, no stagger, no blur
- No layout shift during animation (characters must reserve space)
- 60fps on mobile during headline reveal (no blur = no compositing layers)

---

## Prompt 88 — ScrollSpy dot navigation

**Status:** Pending

**Context:** Hubtown has a fixed left sidebar with section labels (FUTURE, INNOVATION, COLLABORATION, etc.) that highlight as the user scrolls. This gives wayfinding — the user always knows where they are on the page. TeraSwap's landing page has 6 sections but no scroll indicator.

**Objective:** Add a fixed dot navigation on the left side of the viewport that shows section progress and allows click-to-scroll.

**Requirements:**

1. **Create a new component** `ScrollSpy.tsx` in `src/components/`:

   ```tsx
   'use client'
   
   import { useState, useEffect } from 'react'
   import { motion, AnimatePresence } from 'framer-motion'
   
   interface Section {
     id: string
     label: string
   }
   
   const SECTIONS: Section[] = [
     { id: 'hero', label: 'HERO' },
     { id: 'performance', label: 'ENGINE' },
     { id: 'why-teraswap', label: 'EDGE' },
     { id: 'security', label: 'SECURITY' },
     { id: 'experience', label: 'DESIGN' },
     { id: 'features', label: 'FEATURES' },
   ]
   
   export default function ScrollSpy() { ... }
   ```

2. **ScrollSpy behaviour:**
   - Fixed position on the left side: `fixed left-6 top-1/2 -translate-y-1/2 z-20`
   - Hidden on mobile (below `lg` breakpoint): `hidden lg:flex`
   - Vertical column of small dots (6px circles), one per section
   - Dots are `border border-cream-35` by default, filled `bg-[#C8B89A]` when active
   - The active section is determined by `IntersectionObserver` watching each section's `id`
   - On hover, a label appears to the right of each dot (e.g., "ENGINE", "SECURITY")
   - Label uses `text-[10px] font-medium uppercase tracking-[0.12em] text-cream-75`
   - Label appears with a quick Framer Motion fade+slide (opacity 0→1, x -4→0, 150ms)
   - On click, smooth-scroll to the section: `document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })`

3. **Add `id="hero"` to the HeroSection.** In `LandingPage.tsx`, add `id="hero"` to the `<section>` in `HeroSection`. All other sections already have ids: `performance`, `why-teraswap`, `security`, `experience`, `features`.

4. **Integrate ScrollSpy into page.tsx.** In `src/app/page.tsx`, import and render `ScrollSpy` alongside the landing page:
   ```tsx
   import ScrollSpy from '@/components/ScrollSpy'
   
   // In the landing page render block:
   {page === 'landing' ? (
     <main className="relative z-10 flex flex-1 flex-col">
       <ScrollSpy />
       <LandingPage onLaunchApp={handleLaunchApp} />
       {footer}
     </main>
   ) : ( ... )}
   ```
   
   ScrollSpy should NOT render when `page === 'swap'`.

5. **Visual design:**
   - Dot size: 6px (inactive), 8px (active) — use `transition-all duration-200`
   - Dot spacing: `gap-4` between dots
   - Active dot: filled gold `#C8B89A` with subtle glow `box-shadow: 0 0 8px rgba(200,184,154,0.4)`
   - Inactive dot: `border border-[rgba(200,184,154,0.35)]` with transparent fill
   - A thin vertical line connects all dots: 1px, `bg-cream-08`, behind the dots
   - The line has a gold "progress" segment that fills from top to the active dot

6. **IntersectionObserver config:**
   - `threshold: 0.2`
   - `rootMargin: '-20% 0px -60% 0px'` — bias toward the top of the viewport
   - If multiple sections are intersecting, use the one closest to the top of the viewport

**Do NOT:**
- Make the ScrollSpy interactive on mobile (hidden below `lg`)
- Add scroll-snap or scroll-jacking behaviour
- Change section ordering or content
- Add a scrollbar or progress bar at the bottom of the page

**Files affected:**
- `src/components/ScrollSpy.tsx` — new file
- `src/components/LandingPage.tsx` — add `id="hero"` to HeroSection
- `src/app/page.tsx` — import and render ScrollSpy

**Expected output:** One commit. A vertical line of 6 gold dots appears on the left side of the viewport (desktop only). The active section's dot is filled gold. Hovering any dot shows a label. Clicking scrolls to that section. The dot nav provides the "guided experience" feel of Hubtown without the scroll-jacking.

**Quality criteria:**
- Active dot correctly tracks scroll position
- Click-to-scroll works for all 6 sections
- Labels appear on hover with smooth animation
- Hidden on mobile/tablet (below lg breakpoint)
- Does not overlap with page content (left margin sufficient)
- Lighthouse Performance ≥ 85
- prefers-reduced-motion: labels appear instantly (no animation)

---

## Execution order

P84 → P85 → P86 → P87 → P88 (strictly sequential)

- P84 modifies `LandingPage.tsx` (backgrounds) — must go first
- P85 modifies `ParticleNetwork.tsx` (scroll progress) — P86 depends on its `scrollProgressRef`
- P86 modifies `ParticleNetwork.tsx` (flow lines) — builds on P85's `sp` variable
- P87 modifies `LandingPage.tsx` (headlines) — independent of P85/P86 but needs P84's clean state
- P88 adds new file + minor edits — safest to go last

Each prompt = 1 atomic commit with hash recorded here after completion.

---

## Reference: Hubtown techniques mapped to TeraSwap

| Hubtown Technique | Implementation | Prompt |
|---|---|---|
| Zero section boundaries | Remove all `bg-[rgba(…)]` from sections | P84 |
| Scroll-driven scene evolution | `scrollProgressRef` modifies particle params | P85 |
| Glowing energy streams | Canvas bezier curves with gold concentric-circle glow | P86 |
| Letter-by-letter text reveal | SplitText Framer Motion component (blur desktop-only) | P87 |
| Fixed side navigation | ScrollSpy with IntersectionObserver | P88 |

**NOT implemented (architectural decision):**
- Full 3D scene (requires Three.js — 500KB+ bundle, specialist work)
- Scroll-jacking (bad for DeFi UX — users need normal scroll for trust signals)
- Sound design (inappropriate for a financial protocol)
- Loading screen (our page loads in <2s, no need)

---

## Architect review disposition

| Item | Review | Disposition |
|---|---|---|
| B1 — Prompt collision | P79–P83 used by M-01 Phase 2 | **FIXED** → P84–P88 |
| B2 — Branch stale | `redesign/landing-page` merged (PR #81) | **FIXED** → `redesign/cinematic-landing` from main |
| B3 — P78 state wrong | P78 committed (934c9cc) and deployed | **FIXED** → prerequisite updated, P84 starts from current production |
| R1 — Keep bg 12% | Mathematically useless (1 luminance unit) | **REJECTED** → text-shadow is the real readability mechanism |
| R2 — blur(4px) expensive | Valid concern for mobile compositing | **ACCEPTED** → blur reduced to 2px, desktop-only |
| R3 — Flow line scroll-height | Canvas is `fixed inset-0` = viewport, not scroll height | **REJECTED** → factually incorrect, no correction needed |
| R4 — shadowBlur expensive | Concentric circles = same visual, zero compositing | **ACCEPTED** → 3 concentric arcs replace shadowBlur |
