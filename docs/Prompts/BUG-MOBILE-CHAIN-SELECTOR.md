# BUG-MOBILE-CHAIN-SELECTOR — chain selector unreachable on mobile (users stuck on the default chain)

> **Source:** owner report 2026-07-21 with an iPhone screenshot (teraswap.app, Brave, wallet DISCONNECTED):
> the mobile header renders only the theme toggle + CONNECT — **the ChainSelector trigger (#310) is absent
> entirely**, so mobile users cannot switch chains at all (stuck on the default → can't reach Base/Arbitrum;
> "estamos a perder users nesse ambiente"). Possible mechanisms (VERIFY, don't assume): responsive class
> hiding the trigger at small breakpoints (`hidden md:*`), header overflow clipping it, or a connected-only
> conditional. Secondary observation (REPORT ONLY, do not fix here): the mode-tabs row overflows
> horizontally on mobile (Swap/Portfolio scrolled off-screen with no affordance).
> Display/UX only, no gating/routing changes → no Auditor gate. SSH-signed; branch
> `fix/mobile-chain-selector` off `origin/main`, dedicated worktree; 2-3 droppable commits.
> **Do NOT touch `SwapBox.tsx`** (a parallel PR `fix/swapcard-chain-label` owns it — avoid conflicts).
> **Exit = push + local suite green + compare link (CI runs when the owner opens the PR).**

## Requirements (per-commit)

### 1. Diagnose + trigger visibility
Find why the trigger doesn't render on small viewports (inspect `Header.tsx` + `ChainSelector.tsx` trigger
markup/classes). State the exact mechanism in FEEDBACK. Fix: a **compact trigger (current-chain icon, no
name) always visible in the mobile header** between the theme toggle and CONNECT; full trigger (icon+name)
from the existing breakpoint up. The trigger must render **with AND without a connected wallet** — chain
selection is app-level state (quoting/UI); wagmi `switchChain` is invoked only when a wallet is connected,
otherwise selection just updates the app chain (verify the existing app-chain state path supports this; if
selection is currently wallet-gated, decouple the UI state from the wallet call — same pattern the desktop
disconnected state should already use).

### 2. Mobile ergonomics of the picker
On small viewports the #310 popover renders as a **bottom sheet / full-width panel**: touch targets ≥44px,
search input does not trigger iOS zoom (font-size ≥16px), scroll containment (no body scroll-through), Esc
equivalent = tap-outside + close affordance. Desktop popover unchanged. Reuse the ONE component — variant
by breakpoint, not a second implementation.

### 3. Tests + report
- Tests: trigger present in header markup at mobile breakpoint (class-based assertion or viewport-mocked
  render); trigger present when `useAccount` is disconnected; selection while disconnected updates app
  chain WITHOUT calling switchChain; selection while connected calls switchChain (existing behavior);
  comingSoon still non-selectable; existing ChainSelector/Header/parity tests green and untouched.
- FEEDBACK reports (no fix): the mode-tabs overflow observation + any other mobile-header overflow found.

## Do NOT
Touch SwapBox.tsx, routing/quote/gating logic, registry, wagmiConfig; redesign desktop; add deps
(hand-rolled sheet if none present); open a PR.

## Files affected (read ONLY these + tests)
`src/components/Header.tsx`, `src/components/ChainSelector.tsx` + `.test.tsx`, the app-chain state
hook/store it uses (read; decouple only if wallet-gated), `docs/Prompts/BUG-MOBILE-CHAIN-SELECTOR.md`
(commit this spec). Read-only: `src/lib/chains/registry.ts`, `src/lib/chains/activation.ts`.

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the hiding mechanism found, the mobile trigger + sheet as
built, disconnected-selection behavior, tests added, tabs-overflow report. Owner validates on the Vercel
Preview from a real phone before merge.

## Quality criteria
Chain switching reachable on mobile with and without a wallet; one shared component; desktop unchanged;
zero gating diffs; suite green.
