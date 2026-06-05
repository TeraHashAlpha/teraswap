# Sprint 27 — Landing Page Redesign (Hallmark)

> **Date:** 2026-05-21
> **Branch:** `redesign/landing-page` (from `main`)
> **Priority:** P1 — UX/brand improvement, no fund-flow changes
> **Prerequisite:** Hallmark skill installed (`npx skills add nutlope/hallmark`)

---

## Context

The current landing page at teraswap.app has significant UX issues: excessive
dead space, poor text contrast, slow scroll animations, flat feature hierarchy,
no product preview, and no visual distinction between live and upcoming features.
This is a frontend-only redesign — zero changes to swap logic, contracts, or APIs.

**Output:** a preview build on a feature branch. Do NOT deploy to production.
Push the branch and open a PR so we can review on Vercel Preview before merging.

---

## Design References

Before redesigning, study these three sites using Hallmark to extract their DNA:

```
hallmark study https://jup.ag
hallmark study https://cow.fi
hallmark study https://aave.com
```

- **Jupiter (jup.ag):** best-in-class aggregator landing — dense, data-rich, confident. Great use of metrics above the fold.
- **CoW Protocol (cow.fi):** clean storytelling around MEV protection and batch auctions — directly relevant to TeraSwap's value prop.
- **Aave (aave.com):** premium feel with real-time protocol stats. Trust signals and design quality go hand in hand.

Extract DNA only — do not copy layouts or pixels.

---

## Issues to Fix

### 1. Dead Space & Content Density

The current site has massive empty sections between content blocks. A user
scrolls through 3-4 full viewport heights with only a particle background
and a fading headline. Content should be tighter — every scroll should reward
the user with new information.

### 2. Text Contrast & Readability

Body text on feature cards is light gray (#999 or similar) on a dark background.
Bump to at least #CCC for body copy, #FFF for headings. Run a WCAG AA contrast
check.

### 3. Animation Timing

Elements fade in too slowly on scroll, making the page feel empty before content
appears. Tighten the entrance animations to 200-300ms. Stagger card reveals
instead of animating one at a time with long delays.

### 4. Feature Card Hierarchy

All cards (Meta-Aggregator, Oracle-Verified, Split Routing, etc.) look identical.
The core differentiators (Meta-Aggregator, Oracle Verification, MEV Protection)
should be visually elevated — larger, more prominent, or in a hero-style layout.

"Coming Soon" features (DCA Engine, Limit Orders, Stop Loss) should be clearly
secondary — visually distinct, smaller, or in a separate section marked as
upcoming.

### 5. No Product Preview

Users can't see the actual swap interface before connecting a wallet. Add a
screenshot, mockup, or interactive preview of the trading experience. Show,
don't just tell.

### 6. Mobile Responsiveness

Verify all sections render correctly on mobile — DeFi users frequently browse
on phones before connecting on desktop.

---

## Execution

```bash
# Step 1: Study reference sites (already installed)
hallmark study https://jup.ag
hallmark study https://cow.fi
hallmark study https://aave.com

# Step 2: Audit current landing page
hallmark audit src/app/page.tsx

# Step 3: Redesign
hallmark redesign src/app/page.tsx
```

---

## Prompt for Claude Code

Redesign the TeraSwap landing page. TeraSwap is a DeFi meta-aggregator on
Ethereum — it compares 11 liquidity sources and uses Chainlink oracles for
price verification.

Key problems to solve:

- Too much dead space between sections. Tighten the layout.
- Body text contrast is too low. Fix for WCAG AA.
- Scroll animations are too slow. Use 200-300ms entrances.
- Feature cards all look the same. Elevate the 3 core differentiators
  (Meta-Aggregator, Oracle Verification, MEV Protection) visually.
- Add a product preview section showing the swap interface.
- Separate "Coming Soon" features (DCA, Limit Orders, Stop Loss) visually
  from live features.
- Keep the dark theme with gold accents. Keep the particle network background
  but reduce its opacity so it doesn't compete with content.

Reference sites studied: Jupiter (jup.ag), CoW Protocol (cow.fi), Aave (aave.com).

Do NOT make it look generic. This should feel premium, technical, and
trustworthy — like a protocol handling real money.

---

## Files affected

- `src/app/page.tsx` — main landing page
- `src/components/` — landing page components (cards, hero, sections)
- CSS/Tailwind classes within those components

---

## Do NOT

- Do NOT touch any files in `src/hooks/`, `src/lib/`, or `src/app/api/`
- Do NOT modify swap logic, contract interactions, or API routes
- Do NOT add new dependencies without justification
- Do NOT deploy to production — preview branch only
- Do NOT remove existing functionality — this is a visual redesign

---

## Expected output

One branch (`redesign/landing-page`) with a PR open against `main`.
Vercel Preview URL available for review. No merge until approved.

---

## Quality criteria

- WCAG AA contrast on all text
- Mobile responsive (test at 375px, 768px, 1024px, 1440px)
- Lighthouse Performance score ≥ 90
- No new TypeScript errors
- Visual hierarchy: core features > secondary features > coming soon
- Product preview visible without wallet connection
