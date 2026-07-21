# CHORE-MOBILE-SELECTOR-POLISH

## Context

Owner feedback from a real iPhone on production, post-#321 (`fix/mobile-chain-selector`):

1. **Keyboard bug** — the network picker's search input autofocused on open. On iOS this
   springs the keyboard up immediately, squashing/hiding the sheet; the chain list only
   appeared after dismissing the keyboard.
2. **Aesthetic (owner decision)** — on mobile, render the picker as a centered modal instead
   of the bottom-anchored sheet from #321.

## Objective

Fix the autofocus-on-touch bug and restyle the mobile popover as a centered modal, without
touching desktop behavior, gating, routing, the registry, or wagmiConfig.

## Requirements

- Detect touch/coarse-pointer input via `(pointer: coarse)` media query (`useIsCoarsePointer`
  hook in `ChainSelector.tsx`). Defaults to `false` (desktop/autofocus-on) when `matchMedia`
  is unavailable.
- Search input: `autoFocus` only when NOT coarse-pointer (or `variant="full"`, which has no
  trigger button to refocus and no keyboard-ambush risk). Desktop keeps autofocus.
- Mobile popover: centered modal (`fixed inset-0 flex items-center justify-center`, `max-w-sm`,
  `rounded-2xl`, backdrop) replacing the bottom-anchored sheet. Desktop's positioned popover
  (`sm:absolute … sm:top-full`) is unchanged.
- Keep from #321: >=44px touch targets, 16px search font (no iOS zoom), scroll containment
  (`overflow-y-auto overscroll-contain`), tap-outside-to-close, and an explicit close (✕)
  affordance for the mobile modal (the bottom sheet's drag pill is removed since it no longer
  applies to a centered modal).
- Still the one shared `ChainSelector` component (`compact`/`full` variants unchanged).

## Do NOT

- Touch `SwapBox`, gating/routing/registry/`wagmiConfig`.
- Add dependencies.
- Open a PR.

## Files affected

- `src/components/ChainSelector.tsx`
- `src/components/ChainSelector.test.tsx`
- `docs/Prompts/CHORE-MOBILE-SELECTOR-POLISH.md` (this file)

## Expected output

Branch `chore/mobile-selector-polish` pushed off `origin/main`, local suite/tsc/eslint green,
compare link reported. No PR opened.

## Quality criteria

- Autofocus present on desktop variant, absent on mobile/coarse-pointer variant.
- Centered-modal classes assertable on the mobile variant.
- Existing `ChainSelector` suite green and otherwise untouched.
