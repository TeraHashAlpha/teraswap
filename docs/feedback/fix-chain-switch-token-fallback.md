# fix/chain-switch-token-fallback — FEEDBACK

Bug: `remapTokenToChain` returned the ORIGINAL token on a catalog miss → mainnet SNX stayed "on" Arbitrum (⚠ badge, 1inch "not valid token", "No valid quotes").

## Checklist
- [ ] C1 helper: `remapTokenToChain` → `null` on miss, never a foreign address; new `getDefaultPair` + `remapPairToChain`; test matrix
- [ ] C2 callers: SwapBox chain effect + v2 SwapCard derive via `remapPairToChain`; LandingPage/Hero outcome unchanged
- [ ] C3 guard: render v1 + v2 on every chain after every switch permutation (6-token fixture)
- [ ] Evidence 1–4 (below)

## Owner answers / premise deltas
- **No persisted pair exists** (grep of `src`: no localStorage/sessionStorage/URL for the Swap pair, v1 or v2 — it is in-memory state seeded from `findToken('ETH'/'USDC')`). Owner ruled: **skip persistence**; the "restore" case is covered by `remapPairToChain` being the single choke point + a unit test (stale {SNX mainnet, DAI} on Base → default pair). No new storage key added.

## Findings
(filled as work lands)
