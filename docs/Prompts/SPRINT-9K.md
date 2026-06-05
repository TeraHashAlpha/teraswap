# SPRINT-9K — WalletConnect sessions never settle (prod)

## Symptom (live, affecting all users)
A user scans the WalletConnect QR, approves in their mobile wallet, returns to TeraSwap — and the
dApp is still disconnected. Reown analytics for the project show **0 users / 0 signatures over 7
days**: NO WalletConnect session is completing for ANY user. Systematic, not intermittent.

## Environment ruled out (do NOT chase these)
- projectId in the LIVE bundle is correct: the relay WS carries
  `projectId=5c15fa6d3fb8ba06e20c7cd26340f736` (matches the Reown dashboard).
- Relay WS connects: `wss://relay.walletconnect.org/?...` returns **101 Switching Protocols**.
- Origin `https://www.teraswap.app` — both `teraswap.app` and `www.teraswap.app` are allowlisted and
  the domain is Verified in Reown.
- WC client `@walletconnect js-2.21.1`.
So: not env, not projectId, not domain allowlist. This is a dApp-side integration bug — the pairing
connects but the session the wallet approves never settles into wagmi state.

## Config today
`src/lib/wagmiConfig.ts` uses RainbowKit `getDefaultConfig({ appName, projectId, chains:[mainnet,
base], transports, ssr: true })`. No explicit WalletConnect `metadata` (`url`/`icons`). `config` is a
module-level singleton.

## Investigate (in this order — find the ROOT cause; don't stop at the first plausible patch)
1. **Topic/instance mismatch (most likely for a systematic 0-settle).** Confirm there is exactly ONE
   WalletConnect Core / provider instance. Look in the browser console during connect for
   `WalletConnect Core is already initialized` (or duplicate "Emitting…"/pairing logs). Causes to
   check: the wagmi config being recreated rather than the module singleton; React 18 StrictMode
   double-mount; SSR (`ssr: true`) + client double-init; more than one WagmiProvider/RainbowKitProvider
   in the tree. If the wallet approves a pairing topic the dApp isn't subscribed to, the session never
   reflects → exactly this symptom.
2. **Explicit metadata.** Set RainbowKit/WalletConnect metadata explicitly: `appName: 'TeraSwap'`,
   `appUrl`/`metadata.url: 'https://www.teraswap.app'`, icon — matching the Verified domain. Confirm
   whether the missing/auto-generated url is contributing to a Verify/peer-metadata rejection.
3. **Reconnect / state propagation.** Confirm `reconnectOnMount`, the WagmiProvider/QueryClient setup
   and event handling actually surface `session_settle` into the connected account state, including
   after the user navigates back to the tab.
4. **Versions.** Check `@walletconnect` (2.21.1) / wagmi / RainbowKit for a known session_settle /
   pairing-topic bug at these versions; prefer a minimal targeted fix over a broad bump (note the link
   to the deferred wagmi-v3 migration if a major bump is the only real fix).

## Requirements
- Reproduce first (document a manual repro; add an automated test where the connection logic allows —
  at minimum config-level/unit tests around the provider singleton + metadata).
- Fix the ROOT cause; a real WalletConnect connection must settle AND persist across reload and
  navigation on `https://www.teraswap.app`. Verify a non-zero session reaches the Reown dashboard.
- Mainnet/Base swap behaviour byte-identical otherwise (this is wallet-entry only). Keys server-only.
- Branch `feat/sprint-9k-walletconnect-session`, atomic SSH-signed commits, CI green locally, append
  FEEDBACK.

## Do NOT
- Do NOT touch the projectId, RPC, or safety gates. No contract changes.
- Not a security gate → no Auditor gate, but Preview-test before prod.

## Testing caveat for the owner (note in FEEDBACK)
To test WalletConnect on the Vercel Preview, the Preview `*.vercel.app` domain must ALSO be added to
the Reown allowed-domains list (only the prod domains are allowlisted today). Otherwise verify
directly in production.

## Trailing housekeeping (SEPARATE atomic commit — independent of the WC fix)
Dependabot #99 bumps `github/codeql-action` 3.28.10 → 4.36.0. It is NOT yet applied (the workflow is
still on `b56ba49b…# v3.28.10`). As a final, independent signed commit on this branch, pin the three
`uses: github/codeql-action/{init,autobuild,analyze}` refs in `.github/workflows/codeql.yml` to the
v4.36.0 **annotated-tag commit SHA `7211b7c8…`** (full 40-char SHA — NOT the tag-object `f52b05f4…`),
each with a trailing `# v4.36.0` comment. Verify the CodeQL workflow still runs green. Keep this as
its own commit, clearly separate from the WalletConnect changes.
