# CHORE-WALLET-LOGOS-FIX — wallet-connect modal logos all show the placeholder (likely CSP)

## Context
In the wallet-connect "All Wallets" modal, EVERY wallet logo renders the generic placeholder (a green
landscape) instead of the real icon (Binance, MetaMask, SafePal, Trust, OKX, Fireblocks, Bitget, Uniswap,
Ledger, Zerion, …). Noticed on mobile; likely affects desktop too. When all logos fail uniformly, the wallet
icon images aren't loading — most likely the **CSP `img-src` is blocking the WalletConnect/Reown image CDN**
(`explorer-api.walletconnect.com` / `imagedelivery.net` / `*.walletconnect.com` / `*.reown.com`), so RainbowKit/
AppKit falls back to the placeholder.

## Objective
Wallet logos render correctly in the connect modal on mobile AND desktop, with no CSP violations and the CSP
kept as tight as possible.

## Requirements
1. **Diagnose in a REAL browser (mobile + desktop)** — open the "All Wallets" modal and inspect:
   - **Console** for CSP violations ("Refused to load the image … because it violates the Content Security
     Policy directive img-src …").
   - **Network** for the wallet-icon requests — 404? blocked? what host/source?
   Put the confirmed root cause in FEEDBACK.
2. **Fix:** if CSP (most likely), add the EXACT hosts RainbowKit/WalletConnect needs to `img-src` (and
   `connect-src` if the explorer API is fetched) — e.g. the WalletConnect/Reown image CDN + explorer hosts —
   **no broader than necessary** (don't open CSP up). If the cause is NOT CSP (a broken fallback handler, a
   stale projectId, a version issue), fix the actual cause instead.
3. **Verify in a real browser (mobile + desktop):** the wallet logos render (Binance, MetaMask, SafePal,
   Trust, OKX, etc.), zero CSP violations in console. Before/after screenshots on both.
4. Preserve all other security headers; keep CSP minimal.

## Do NOT
- Don't broaden CSP beyond the specific hosts needed. Don't change the wallet/connect logic or the
  projectId-driven flow. Don't regress the connect/sign flows.

## Files affected (verify on main)
- The CSP / security-headers config (next.config / a headers() / middleware) and, if needed, the RainbowKit/
  AppKit wallet-modal config.

## Expected output
- Branch `chore/wallet-logos-fix` off latest `origin/main`; SSH-signed; CI green; FEEDBACK with the confirmed
  root cause + the EXACT CSP hosts added (for owner review — CSP is security-adjacent) + before/after
  screenshots (mobile + desktop). No formal Auditor, but document the CSP delta.

## Quality criteria
Wallet logos render correctly in the connect modal on mobile + desktop; no CSP console violations; the CSP
change is minimal + documented; no regression to connect/sign or other security headers.
