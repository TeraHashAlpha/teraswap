# CHORE-TOKEN-LOGOS-FIX — real logos, not initials (fix the 1inch-CDN source)

The `<TokenLogo>` fallback from #207 works, but it's firing for almost EVERY token (even ETH/USDC) → users see
generated **initials instead of real logos**. Root cause: the catalog's `logoURI` uses
`https://tokens.1inch.io/<address>.png` (the `logo()` fn in `src/lib/tokens.ts` + `src/lib/chains/tokens.ts`) —
the **1inch CDN is mainnet-keyed and 404s for Base addresses** (there's already a `// 1inch logo returns 403`
TODO in the file). So the primary source fails → fallback → initials. **Fix the SOURCE so real logos load
reliably (Matcha-level), with initials only as a true last resort.** Continue on branch
`sprint/token-selector-ux` (PR #207, not yet merged) so it merges complete. Frontend only; CI green; FEEDBACK.

## Requirements
1. **Replace the 1inch `logo()` source** with reliable resolution that actually serves Base + mainnet:
   - **Core curated set** (ETH, WETH, USDC, USDT, DAI, cbETH, WBTC, LINK, UNI, USDbC, …): use **local bundled
     assets** in `/public/tokens/<symbol|address>.png` — 100% reliable, no external 404, instant (this is how
     Matcha-grade UIs guarantee the popular logos). Add the image files.
   - **Long tail / discovered:** resolve via a comprehensive CDN by contract address — **CoinGecko token images**
     and/or **Trust Wallet per-chain** (`blockchains/{ethereum,base}/assets/<EIP-55-checksummed>/logo.png`).
     Use the correct per-chain path + checksummed address (the current TW fallback is likely 404ing on a wrong
     path/casing).
   - Native ETH: a known-good local/asset logo.
2. **Keep the `<TokenLogo>` fallback chain** but reorder so the reliable sources come first and the **generated
   initials avatar is the LAST resort only** — it should be rare in practice.
3. Pass the correct `chainId` into the resolver so Base vs mainnet pick the right per-chain logo path.

## Verify (must do — this regressed once already)
- In the Vercel Preview, on **both Base and mainnet**: ETH, USDC, WETH, cbETH, WBTC, DAI, LINK, UNI and the
  discovered "Your Tokens" all show their **real logos**, NOT initials. Initials appear only for a genuinely
  unknown long-tail token. Put before/after notes (or screenshots) in FEEDBACK.
- Test: a token with a known logo resolves to the real image URL (not the avatar); only a no-logo token hits
  the avatar. Keep the #207 in-place-token-change reset test.

## Do NOT
- No backend/contract changes. Don't regress the verified badge or category filter from #207. Keep the
  avatar as the final fallback (don't remove it — just make it rare).

## Output
- On `sprint/token-selector-ux`: local logo assets + the new resolver, initials demoted to last resort,
  chainId-aware. FEEDBACK with the Preview verification (real logos confirmed on Base + mainnet). No Auditor.
