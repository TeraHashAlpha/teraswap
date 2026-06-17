# SPRINT-9Z — Mobile WalletConnect: wallet list + session persistence (Rabby/Ledger/D'CENT)

## Symptoms (prod, mobile — real users losing access)
- Can't find Rabby (and others) in the wallet picker on mobile.
- "Connect, return to the site, and it's NOT connected."
- Ledger / D'CENT users can't connect at all.
Desktop is mostly OK (9K fixed the dup-Core 0-session case). This is the MOBILE flow.

## Root causes (investigated — code + ecosystem research)
1. **No explicit wallet list.** `src/lib/wagmiConfig.ts` uses RainbowKit `getDefaultConfig` with NO
   `wallets` array → the default list curates a subset and hides several wallets on mobile. Leaders use
   an explicit `connectorsForWallets` / `wallets` list incl. a generic `walletConnectWallet` catch-all.
2. **`WalletSessionGuard` (src/components/WalletSessionGuard.tsx)** auto-disconnects after 1h idle AND
   has an "expired while tab inactive" check. On mobile, tapping a wallet backgrounds the tab (wallet
   app foregrounds) during the WC deep-link handshake → this guard can disconnect mid-handshake / right
   after connect (stale `connectedAt`), counting the deep-link backgrounding as "inactivity." No major
   dApp ships a hard 1h auto-disconnect; it's fragile in the mobile lifecycle.
3. **Mobile relay/session-settle + versions.** WC v2 relay WS is suspended when the tab backgrounds;
   on return the session_settle can be missed. RainbowKit 2.1.0 / wagmi 2.19.5 are behind — 2.2.x has
   mobile + multi-instance (#2232) fixes. (wagmi v3 major stays deferred — ADR-008.)

## Fix
### A — Explicit, mobile-friendly wallet list
Replace the default list with an explicit one (RainbowKit `connectorsForWallets` or `getDefaultConfig`'s
`wallets` param). Groups e.g. "Recommended": `rabbyWallet`, `metaMaskWallet`, `coinbaseWallet`,
`walletConnectWallet`; "More": `ledgerWallet`, `injectedWallet`, others. The generic
`walletConnectWallet` MUST be present (covers D'CENT and any WC wallet via QR/deep-link). Keep the 9K
explicit metadata (url=https://www.teraswap.app) + single WC Core (9K dedup must hold). Verify the list
renders on BOTH mobile and desktop; mobile shows the horizontal-scroll hint.

### B — Fix WalletSessionGuard for the mobile lifecycle (it's a security feature — keep the intent)
The 1h idle auto-disconnect must NEVER fire during or right after a connect, and tab-backgrounding for
a wallet deep-link must NOT count as idle. Concretely:
- Reset `connectedAt` on every NEW connection (on isConnected false→true), so a fresh connect can never
  read a stale expiry.
- Do not run the "expired while inactive" disconnect within a grace window of a connection, and ignore
  visibility/background changes caused by the WC handshake.
- Reassess whether the hard 1h auto-disconnect should exist at all on mobile; if kept, make it robust;
  if the team prefers, gate it behind a setting or lengthen/remove it. Document the security tradeoff
  (it's an auto-logout control) for a LIGHT Auditor note.

### C — Version bump (within v2, NOT wagmi v3)
Bump @rainbow-me/rainbowkit to the latest 2.2.x and wagmi/viem/WalletConnect to their latest compatible
2.x patch/minor that carries the mobile + multi-instance fixes, keeping the 9K overrides (single
@walletconnect/core). Run the full suite + `next build`; confirm still ONE @walletconnect/core. If a
bump forces wagmi v3, STOP — out of scope, report.

## Reference (how leaders do it)
Explicit wallet list + generic WalletConnect catch-all + current RainbowKit/wagmi + correct metadata.
RainbowKit custom-wallet-list docs: https://rainbowkit.com/docs/custom-wallet-list

## Tests (TDD where possible)
- wagmiConfig wallet list includes rabby/ledger/metamask/coinbase/walletConnect/injected; renders both
  platforms (mock mobile UA).
- WalletSessionGuard: a fresh connect never disconnects; connectedAt resets on connect; a simulated
  background/visibility change during handshake does NOT disconnect; genuine 1h idle still disconnects.
- Single @walletconnect/core after the bump; mainnet/Base swap behaviour byte-identical.

## Do NOT
- No swap/gate/FeeCollector/adapter/oracle changes. No wagmi v3 major. Keys server-only. Mainnet
  byte-identical.
- Branch `feat/sprint-9z-mobile-walletconnect`, atomic SSH-signed commits (A / B / C separate), CI
  green, append FEEDBACK. WalletSessionGuard change touches an auth/security control → LIGHT Auditor
  note. **The decisive verification is REAL DEVICES (iOS Safari + Android Chrome, with Rabby + Ledger
  + D'CENT) — that is an OWNER post-merge step; do everything automatable, then STOP (no loop).**
