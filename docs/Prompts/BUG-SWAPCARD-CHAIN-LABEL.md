# BUG-SWAPCARD-CHAIN-LABEL — swap card shows "ETHEREUM" while on Arbitrum (icon correct, name wrong)

> **Source:** owner repro on production 2026-07-20, minutes after the Arbitrum prod flip: with the network
> switched to Arbitrum One (header/selector correct), the swap card's chain badge renders the ARBITRUM icon
> but the TEXT "ETHEREUM". Base renders correctly ("BASE"). Diagnosis to confirm: the badge's icon and name
> come from different sources — the name lookup falls back to mainnet/"Ethereum" for 42161 instead of
> reading the chain registry. Display-only (routing/quotes key off chainId) → no Auditor gate.
> SSH-signed; branch `fix/swapcard-chain-label` off `origin/main`, dedicated worktree; 1-2 droppable commits.
> **Exit = push + local suite green + compare link (CI runs when the owner opens the PR).**

## Requirements
1. Find the swap-card chain badge (SwapBox header area rendering "BASE"/"ETHEREUM" + ChainIcon). Identify
   why the NAME resolves wrong for 42161 (hardcoded map missing the entry / stale fallback / different
   source than the icon). State the mechanism in FEEDBACK.
2. Fix: the badge name AND icon both resolve from the SINGLE chain registry source
   (`CHAIN_CONFIGS`/`getSupportedChainIds` naming) by the ACTIVE chainId. Kill the divergent lookup — one
   source of truth. No visual redesign; text case/styling unchanged.
3. Sweep: grep for other hardcoded chain-name strings ("Ethereum", "Base", "Arbitrum") in UI components
   that should come from the registry — fix ONLY trivial same-class instances (label lookups); report
   anything bigger without widening the diff.
4. Tests: badge renders "Arbitrum One" (or the registry's exact name) for 42161, "Base" for 8453,
   "Ethereum" for 1; regression for the icon/name pairing (same registry entry feeds both).

## Do NOT
Touch routing/quote/gating logic, the registry values themselves, wagmiConfig, the ChainSelector (#310);
add deps; open a PR.

## Files affected (read ONLY these)
The swap-card badge component (SwapBox.tsx or its header child), any chain-name label util it uses + tests,
`docs/Prompts/BUG-SWAPCARD-CHAIN-LABEL.md` (commit this spec). Read-only: `src/lib/chains/registry.ts`.

## Expected output
Branch pushed + compare link. FEEDBACK ≤1 screen: the divergent-lookup mechanism, the unified source, sweep
results, test names.
