# SPRINT-9N — COOP fix for Coinbase Smart Wallet (popup window.opener)

## Symptom (prod)
Connecting **Coinbase Smart Wallet** opens the `keys.coinbase.com/connect` popup, which then shows
"This application does not support smart wallets — window.opener is inaccessible (COOP policy)". The
popup needs `window.opener` to return the connection to the dApp; our COOP header severs it.

## Root cause
`Cross-Origin-Opener-Policy: same-origin` is set in BOTH layers (defense-in-depth, added SPRINT-6D):
- `next.config.js` (~lines 77-78)
- `vercel.json` (~line 17)
`same-origin` strips the opener from any popup the page opens → Coinbase Smart Wallet (and any
popup/passkey-based wallet flow) cannot communicate back. NOT related to 9L or the WalletConnect
relay (WC uses a WebSocket, not window.opener).

## Fix
Change **only** `Cross-Origin-Opener-Policy` from `same-origin` → **`same-origin-allow-popups`** in
BOTH `next.config.js` and `vercel.json` (keep them consistent). This is the standard, recommended COOP
value for dApps that open wallet popups: it preserves COOP isolation of the document from cross-origin
openers, but lets popups THIS document opens keep their `window.opener`.

## Requirements
1. Edit only the COOP value in the two files. Do NOT change CORP (`Cross-Origin-Resource-Policy`),
   CSP, HSTS, Permissions-Policy, X-Frame-Options, or any other header.
2. Confirm nothing in the app relies on `crossOriginIsolated` / SharedArrayBuffer (which needs the
   stricter COOP `same-origin` + COEP `require-corp`). If something does, STOP and report — don't
   silently break cross-origin isolation.
3. Verify the response actually carries `same-origin-allow-popups` (both Next and Vercel-edge layers
   must agree, or the stricter one wins). Document how you verified.
4. Manually confirm Coinbase Smart Wallet connects after the change; confirm other wallets and swap
   behaviour are unaffected (mainnet/Base byte-identical).
5. Branch `feat/sprint-9n-coop-popups` off latest `origin/main`, atomic SSH-signed commit, CI green,
   append FEEDBACK. Preview-test before prod.

## Security note (deliberate relaxation of a hardening control)
This relaxes a documented security header (COOP, SPRINT-6D). `same-origin-allow-popups` is still a
strong, OWASP-recommended value and the standard for wallet-popup dApps — the only change is allowing
opener access for popups the page itself opens. Because it touches a hardening control, give the
**Auditor a light review** (confirm the relaxation is bounded to allow-popups, CORP/CSP untouched,
nothing relied on crossOriginIsolated). This is NOT a contract/fund-flow gate.
