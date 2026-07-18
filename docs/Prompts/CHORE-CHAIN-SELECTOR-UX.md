# CHORE-CHAIN-SELECTOR-UX — network-picker redesign (Relay/Uniswap-style dropdown) across all TeraSwap menus

> **Source:** owner request 2026-07-17 with a reference screenshot of a modern network picker (Relay-style):
> a dark popover with a "Search networks…" input at the top, a scrollable vertical list where each row is a
> circular chain logo + chain name, the ACTIVE chain marked with a right-aligned checkmark, subtle hover
> states, rounded container. Owner wants TeraSwap's chain selection to look/behave like this **in every menu
> where a chain is picked**. Display/UX only — **zero behavior/gating changes** → no Auditor gate.
> SSH-signed; branch `chore/chain-selector-ux` off `origin/main`, dedicated worktree; 3 droppable commits.
> **Exit = push + CI green + compare link; the owner opens the PR** and validates visually on the Vercel
> Preview before merge (same flow as CHORE-ARBITRUM-UI-POLISH).

## Target design (from the reference)
Popover/dropdown panel: dark surface consistent with the app's existing Tailwind tokens, rounded-xl border,
max-height with scroll. Top: search input (magnifier icon, placeholder "Search networks…", autofocus on
open, filters by name prefix/substring, case-insensitive). List rows: ~40px height, 24px circular chain
logo + chain name; selected chain shows a checkmark right-aligned; hover = subtle bg; keyboard navigation
(arrows + Enter + Esc) and ARIA listbox/option semantics. Inactive/dark chains (comingSoon) render dimmed
with the existing "SOON" badge and are NOT selectable. Mobile: same component, touch-friendly hit areas.

## Requirements (per-commit)
### 1. The component
Rebuild `src/components/ChainSelector.tsx` ('use client') to the target design. Chain LIST + active state
+ gating stay EXACTLY as today: chains from the existing registry (`getSupportedChainIds()`/CHAIN_CONFIGS),
`comingSoon = feeCollector === null` remains the sole activation gate, selection triggers the same wagmi
`switchChain` flow. Chain logos: bundled local SVG/PNG assets (mainnet/Base/Arbitrum + any registry chain),
NO runtime hotlinking to third-party logo CDNs; fallback = monogram circle. No new chains, no reordering
logic beyond what exists.

### 2. Every menu
Sweep for every place a chain is picked or displayed as a picker (grep ChainSelector/switchChain usages:
Header, page.tsx, ModeTabs/panels if they embed one). All of them use the ONE shared component (variants via
props: compact trigger for the Header showing current-chain logo+name; full for forms). Delete any
duplicated ad-hoc selector markup. `SwapButton`'s wrong-network CTA behavior unchanged.

### 3. Tests + a11y
Extend `ChainSelector.test.tsx`: search filters the list; active chain shows the checkmark; comingSoon rows
disabled (click does NOT call switchChain) + badge present; Esc closes; ARIA roles (listbox/option,
aria-selected); keyboard arrows+Enter select. Existing tests (incl. the wagmi↔registry parity guard in
wagmiConfig.test.ts) stay green and UNTOUCHED.

## Do NOT
Touch activation/gating logic (isChainActive, registry, envs), wagmiConfig, routing/swap/order logic, the
parity-guard test; add chains; hotlink external logo CDNs; introduce new deps beyond what's in the repo
(headlessui/radix ONLY if already present — else hand-rolled popover); open a PR.

## Files affected (read ONLY these + new assets)
`src/components/ChainSelector.tsx` + `.test.tsx`, `src/components/Header.tsx`, `src/app/page.tsx`, any
component found embedding a chain picker (list them in FEEDBACK), new logo assets under `public/` (or the
existing asset location), `docs/Prompts/CHORE-CHAIN-SELECTOR-UX.md` (commit this spec). Read-only:
`src/lib/chains/registry.ts`, `src/lib/chains/activation.ts`, `src/lib/wagmiConfig.ts`, Tailwind config.

## Expected output
Branch pushed, CI green (push + report, don't poll), compare link. FEEDBACK ≤1 screen: the usage sites
unified (list), props API of the component, logo asset sources, tests added. Owner does the visual pass on
the Vercel Preview.

## Quality criteria
One shared component everywhere; pixel-feel matches the reference (search + logos + checkmark + hover);
zero gating/behavior diffs (comingSoon + switchChain identical); a11y + keyboard complete; CI green.
