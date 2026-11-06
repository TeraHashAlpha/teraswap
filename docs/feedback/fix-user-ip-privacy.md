# Feedback — fix/user-ip-privacy

Base: origin/main `fabaa30`. Recon: `docs/feedback/recon-user-ip-privacy.md` (origin/recon/user-ip-privacy `482f309`).
Owner goal: "this site never sends the user's IP to a third party" is TRUE for everything the site controls, and the
copy says plainly what the wallet does on its own. DRAFT PR, Auditor required (RPC proxy + rate limiting).

## Checklist
- [x] C1 L2 reads through `/api/rpc?chainId=` (wagmi + clients.ts), allow-list, batch cap, per-call limit, 1–2 s cache
- [x] C2 imported-token + portfolio logos → `/api/token-logo`; WalletConnect page-load telemetry/config off
- [x] C3 CSP: connect-src 'self' + exact wallet hosts; img-src 'self' data: blob:; remotePatterns dropped; CI capture job
- [x] C4 rate-limit keys + log lines use HMAC(IP, daily salt); four raw-XFF routes → trustedClientIp; Sentry statement
      (committed before C3: C3 waits on an owner decision — F8)
- [ ] C5 honest copy, v1 == v2 (Help, Docs, Privacy §3.2/§5/§8, product-claims) + content-map delta
- [ ] Verify: suite vs origin/main, lint delta 0, tsc, build, v1/v2 parity, rpc-budget, capture, CodeQL 0 new
- [ ] Evidence 1–6 below; branch pushed; compare link

## Findings (filled as found)
- **F1 (pre-existing, High for WalletConnect users).** On `main`, a WalletConnect session that includes Ethereum throws
  while its EVM provider is built: wagmi copies each transport URL into WalletConnect's `rpcMap`, mainnet's is the
  relative `/api/rpc`, and WalletConnect's `HttpConnection` rejects it (`Provided URL is not compatible with HTTP
  connection: /api/rpc`). Reproduced against the real `@walletconnect/universal-provider` 2.21.1
  (`wagmiConfig.browser-transports.test.ts`, with a relative-URL control). Not observed on prod — the owner should
  confirm whether WalletConnect connects there today. Fixed here for all three chains: browser transports use the
  absolute same-origin URL (`rpc-proxy-url.ts`). This is the one change to the mainnet transport.
- **F2.** `NEXT_PUBLIC_RPC_URL` (mainnet) is still inlined into the client bundle by `wagmiConfig.ts:28` and
  `chains/registry.ts:23`, although the browser never calls it. Out of the stated scope (L2 names); same fix applies.
- **F3 (deploy precondition).** After this ships, `RPC_URL_8453` / `RPC_URL_42161` carry every Base/Arbitrum read. If
  they are unset the proxy falls back to the deprecated `NEXT_PUBLIC_*` key — rejected server-side once that key has
  its domain allow-list — then to the public endpoint. Set both in Vercel (Production + Preview) first.
- **F4.** `/api/rpc` 300 calls/min per IP is now shared by three chains (it was mainnet only). Measured steady load is
  ≤6 calls/min per wallet tab (rpc-budget), so one user is far below it; many users behind one NAT share the bucket.
- **F5 (SDK limit, answers "disable AppKit analytics in init if the SDK allows").** It does not, on this path. The
  page-load `pulse.walletconnect.org/e` + `api.web3modal.org/appkit/v1/config` come from Reown AppKit, created by
  `EthereumProvider.init({ showQrModal: true })` for RainbowKit's second ("official modal") WalletConnect connector.
  `@walletconnect/ethereum-provider` builds AppKit's options itself (`convertWCMToAppKitOptions`): `features` is
  hard-coded and nothing in `qrModalOptions` reaches `features.analytics`. So: (a) that one connector is lazy
  (`lazy-walletconnect.ts`) — nothing is created or fetched until WalletConnect is chosen, or for a returning visitor
  whose last connector was WalletConnect; (b) `pulse.walletconnect.org` is not in the CSP (C3). WalletConnect *core*
  telemetry is a separate switch (`telemetryEnabled`), already off by RainbowKit default and now pinned off.
- **F6 (lazy-load answer).** The WC config fetch is deferred further than "until Connect is opened": until the user
  picks the official WalletConnect modal. EIP-6963 / injected wallets never go through WalletConnect and are untouched;
  the QR connector (RainbowKit's own modal) is untouched and made no page-load request before either.
- **F7.** The portfolio's discovery route returns the provider's own image-CDN URL as `logoURI` for non-catalog tokens;
  the browser used to try it (already refused by img-src) before falling back to 1inch. Both are replaced by the
  same-origin logo route. ENS avatars (`WalletModal.tsx:140`, `ui/v2/shell/AccountPanel.tsx:70`) still render whatever
  URL the ENS record holds; img-src refuses anything off-origin, so only a `data:` avatar loads. Not changed.
- **F8 (recon gap → owner: remove).** With a wallet connected the browser opens a Supabase Realtime
  WebSocket — `wss://<project>.supabase.co/realtime/v1/websocket?apikey=…`, filtered by the wallet address
  (`order-engine/supabase.ts` `subscribeToOrders`, mounted by `useOrderEngine`). Measured in real Chromium on this
  branch. The recon's rig recorded HTTP only, so it reported "no additional host on connect". It is a third party
  receiving IP + wallet address from something the site controls, and the owner's CSP spec has no place for it.
  Removed (C3): no Supabase client in the browser; `useOrderEngine`'s 10 s poll through `/api/orders` is the only
  source and now applies fill count / tx hash / amount / error / executed-at on every change, not only on a status
  change (a DCA stays `partially_filled` between fills). Order updates are up to 10 s later than a pushed event.
  `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` are no longer in any client chunk; `env-validation.ts` still lists them as
  required because five server routes fall back to the URL name (owner can move to `SUPABASE_URL`).
- **F9 (deploy precondition).** `RATE_LIMIT_SALT` must be set in Vercel (Production + Preview). Unset is safe for
  privacy (a per-process random salt) but each function instance then names a client's bucket differently, so a
  per-IP limit is enforced per instance, not across the fleet. One warning per instance names the variable.
- **F10.** Bucket names rotate at 00:00 UTC, so every per-IP window restarts once a day (≤1 extra window around
  midnight; the 0x hourly quote-build cap is keyed on the same hash). Accepted as the cost of an unlinkable daily salt.
- **F11 (Sentry).** Not initialised anywhere, measured: a production build with a dummy DSN has it in 0 client and
  0 server files, on `origin/main` and here; there is no `instrumentation.ts` / `instrumentation-client.ts`. Written
  down in `docs/security/SENTRY-STATUS.md`, pinned by `sentry-not-initialised.test.ts`. Not enabled. Not verified:
  the Sentry project inbox itself (owner).
- **F12 (my bug in C2, found by the wallet spec, fixed in C3).** RainbowKit calls `connector.getChainId()` before
  `connect()`; the lazy connector armed only on `connect()`, so "open the official WalletConnect modal" threw and did
  nothing. It now arms on both. Unit test reproduces RainbowKit's order on a spread copy of the connector.
- **F13 (pre-existing, owner decision).** WalletConnect's Verify API is an `<iframe>` to `verify.walletconnect.org`;
  `frame-src 'none'` refuses it today and still does, so a wallet cannot verify the domain and may show the site as
  unverified. Allowing it means that host sees the IP when a WalletConnect pairing starts. Not changed.
- **F14.** Hosts deliberately NOT in connect-src although the old wildcards allowed them: `pulse.walletconnect.org`
  (telemetry), `rpc.walletconnect.org` (the provider gets our proxy for all three chains; AppKit's optional identity
  lookup after an official-modal connect would be refused), `verify`/`echo`/`explorer-api`, `api.web3modal.com`.
  WalletConnect's modal also asks for a Google Fonts stylesheet; style-src refuses it as before.
- **F15 (not verified — owner, on a Preview deployment, before production).** A real WalletConnect session against
  the real relay with a real wallet (QR and official modal), and MetaMask-without-extension through the MetaMask SDK.
  Headless coverage stops at: pairing published to a mock relay, QR drawn, official modal created, telemetry refused,
  no page error. Coinbase Smart Wallet uses a popup (not governed by connect-src) and was not exercised.
- **F16.** The CI job needs the repository variables `NEXT_PUBLIC_BASE_FEE_COLLECTOR` /
  `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` (as `v2-mobile-parity` already does): without them Base/Arbitrum cannot be
  selected and the capture fails on "must have read Base through /api/rpc?chainId=8453" rather than passing vacuously.
  It adds ~7 min of CI per PR (build + 11 browser scenarios).

## Owner answers (2026-11-06, in session — these supersede the goal text)
1. **Supabase Realtime socket (F8):** remove it; widen the order poll. Done in C3.
2. **Copy source:** the recon's interim wording was chat-only, so the owner supplied it — "TeraSwap's server relays all
   RPC reads on Ethereum, Base and Arbitrum, every aggregator quote and swap request, and token logos, so those
   providers see our server's IP address, not yours. Your wallet's own RPC connection and the transactions it
   broadcasts are outside our control; the WalletConnect relay sees your connection once you choose a WalletConnect
   wallet. Use a privacy RPC in your wallet settings if that matters to you. We do not store IP addresses in our
   database; our hosting and rate-limiting layers process them transiently, and our rate limiter only ever sees a
   one-way hash. We do store wallet addresses for orders, swap history and activity." Adapt tense to the final
   state; list every sentence changed.
3. **Proxy upstream when `RPC_URL_<id>` is unset:** keep the #628 order (deprecated `NEXT_PUBLIC_*` as a server-only
   fallback, then the public endpoint). As implemented in C1.

## Evidence (filled as measured)
