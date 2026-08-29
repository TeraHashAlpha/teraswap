# Status-palette colour-vision deficiency measurement (2026-08-29)

The status tokens in `tailwind.config.ts` — `success` `#4ADE80`, `warning` `#F59E0B`,
`danger` `#EF4444` — separate well under normal vision (CIEDE2000 34–77) and collapse
under red–green deficiency. On a DEX these three colours carry "safe / degraded /
blocked". This is a functional defect, not a cosmetic one. Normal vision passes
comfortably, which is why nobody saw it.

**The palette is UNCHANGED.** This document records the measurement, the regression
check, and candidate replacements. Replacement hex values are **PROPOSALS awaiting
the owner** and are not applied anywhere.

This check does **not** make the UI accessible. Colour separation is a backstop.
The actual guarantee is the standing rule that colour is always paired with an
icon and a label and never carries meaning alone.

---

## Measured table (shipped checker)

Values are CIEDE2000 from `node scripts/check-color-contrast.mjs` against the live
`tailwind.config.ts`. Floor = 15. "baselined" means currently under the floor and
listed in `DEFAULT_BASELINE` so CI stays green today; a new miss, or a listed pair
that starts passing, fails the check.

| condition    | pair             | dE2000 | status    |
|--------------|------------------|--------|-----------|
| normal       | success/warning  | 46.0108 | pass     |
| normal       | success/danger   | 76.6796 | pass     |
| normal       | warning/danger   | 34.4751 | pass     |
| deuteranopia | success/warning  | 13.2531 | baselined |
| deuteranopia | success/danger   | 14.9815 | baselined |
| deuteranopia | warning/danger   | 14.1854 | baselined |
| protanopia   | success/warning  | 13.4707 | baselined |
| protanopia   | success/danger   | 33.3928 | pass     |
| protanopia   | warning/danger   | 26.7063 | pass     |

A prior notebook listed three under-15 pairs (deuteranopia success/warning 13.19,
deuteranopia warning/danger 14.30, protanopia success/warning 13.44) and did not
flag deuteranopia success/danger. The shipped checker measures that fourth pair at
14.9815, just under the floor. All currently-under-15 pairs are baselined. Two-decimal
disagreement with the notebook is expected (RGB→Lab rounding); the contract is the
floor, not the unpublished notebook.

Roughly 6% of men are deuteranope. Under deuteranopia every status pair is currently
under 15.

---

## Method

1. Parse `success` / `warning` / `danger` hex out of `tailwind.config.ts`. The checker
   never hard-codes those hex values; if the palette moves, the check follows it or
   fails loudly (missing/ambiguous key).
2. Convert sRGB hex → linear RGB (IEC 61966-2-1) → CIE Lab (D65).
3. For deuteranopia and protanopia, apply the Viénot / Brettel / Mollon 1999
   linear-RGB approximation *before* the Lab step: Hunt-Pointer-Estevez LMS, then
   substitute L (protanopia) or M (deuteranopia) using the 1999 coefficients, then
   convert back to linear RGB. Neutral grey is preserved (verified).
4. Compute CIEDE2000 (Sharma et al. 2005, kL = kC = kH = 1) for every pair under
   every condition. Fail any pair with dE2000 < 15, except the explicit baseline.

Tritanopia, WCAG contrast against backgrounds, and non-status tokens (gold, cream,
surface, text) are out of scope.

---

## Reference vector (proof the metric is CIEDE2000, not CIE76)

Sharma et al. 2005, pair 1:

- Lab₁ = (50.0000, 2.6772, −79.7751)
- Lab₂ = (50.0000, 0.0000, −82.7485)
- published ΔE₀₀ = **2.0425**

The shipped `ciede2000` must match 2.0425 within 1e-4. A CIE76 (Euclidean Lab)
implementation of the same pair returns ~4.00 and **must fail** that test. Identical
colours yield 0. Both assertions live in `scripts/check-color-contrast.test.mjs` and
import the shipped function — they do not re-implement it.

---

## Honest limit

Colour separation is a backstop, not accessibility.

- This check does not make the UI accessible.
- It does not claim WCAG 2.x contrast compliance.
- It does not cover tritanopia, greyscale, or contrast against `surface` / `text`.
- Status colour on this product is always paired with an icon (or status dot) and a
  text label (`Operational` / `Degraded` / `Disabled`, and the analogous copy on
  swap/order surfaces). Colour never carries meaning alone. That pairing is the
  actual guarantee; the dE2000 floor only stops the three status hues from collapsing
  into each other for the two most common dichromacies.

---

## PROPOSALS — replacement hex (not applied)

Brand colours are the owner's decision. None of the values below are written into
`tailwind.config.ts` or any other file except this document. They were measured with
the same shipped checker. Every pair clears dE2000 15 under normal, deuteranopia, and
protanopia.

### Proposal A — keep danger, shift success toward teal, warning toward yellow

| token   | current   | **PROPOSAL** |
|---------|-----------|--------------|
| success | `#4ADE80` | `#00C2A8`    |
| warning | `#F59E0B` | `#FFD60A`    |
| danger  | `#EF4444` | `#EF4444` (unchanged) |

Minimum dE2000 across the 3×3 = **23.1513** (deuteranopia warning/danger).

### Proposal B — keep danger, teal success, amber-yellow warning

| token   | current   | **PROPOSAL** |
|---------|-----------|--------------|
| success | `#4ADE80` | `#00A3A1`    |
| warning | `#F59E0B` | `#FFC107`    |
| danger  | `#EF4444` | `#EF4444` (unchanged) |

Minimum dE2000 across the 3×3 = **20.1517** (deuteranopia warning/danger).

### Proposal C — mint / gold / crimson (changes all three)

| token   | current   | **PROPOSAL** |
|---------|-----------|--------------|
| success | `#4ADE80` | `#2DD4BF`    |
| warning | `#F59E0B` | `#FBBF24`    |
| danger  | `#EF4444` | `#DC2626`    |

Minimum dE2000 across the 3×3 = **24.2763** (deuteranopia warning/danger).

After the owner picks a palette, apply it in a separate change, re-run the checker,
and **remove** each baseline entry that now clears 15. Do not widen the baseline.
Do not treat a passing check as an accessibility claim.

---

## Wiring

- `npm run check:color-contrast` → `node scripts/check-color-contrast.mjs`
- CI `lint` job runs that script (next to `check:agents-parity` / `check:bash3-compat`)
- Vitest includes `scripts/*.test.mjs` (Sharma / identity / grey / mutation / parser)
