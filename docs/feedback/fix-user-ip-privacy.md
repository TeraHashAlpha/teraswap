# Feedback — fix/user-ip-privacy

Base: origin/main `fabaa30`. Recon: `docs/feedback/recon-user-ip-privacy.md` (origin/recon/user-ip-privacy `482f309`).
Owner goal: "this site never sends the user's IP to a third party" is TRUE for everything the site controls, and the
copy says plainly what the wallet does on its own. DRAFT PR, Auditor required (RPC proxy + rate limiting).

## Checklist
- [x] C1 L2 reads through `/api/rpc?chainId=` (wagmi + clients.ts), allow-list, batch cap, per-call limit, 1–2 s cache
- [x] C2 imported-token + portfolio logos → `/api/token-logo`; WalletConnect page-load telemetry/config off
- [ ] C3 CSP: connect-src 'self' + exact wallet hosts; img-src 'self' data: blob:; remotePatterns dropped; CI capture job
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
- **F8 (recon gap, owner decision pending).** With a wallet connected the browser opens a Supabase Realtime
  WebSocket — `wss://<project>.supabase.co/realtime/v1/websocket?apikey=…`, filtered by the wallet address
  (`order-engine/supabase.ts` `subscribeToOrders`, mounted by `useOrderEngine`). Measured in real Chromium on this
  branch. The recon's rig recorded HTTP only, so it reported "no additional host on connect". It is a third party
  receiving IP + wallet address from something the site controls, and the owner's CSP spec has no place for it.
- **F9 (deploy precondition).** `RATE_LIMIT_SALT` must be set in Vercel (Production + Preview). Unset is safe for
  privacy (a per-process random salt) but each function instance then names a client's bucket differently, so a
  per-IP limit is enforced per instance, not across the fleet. One warning per instance names the variable.
- **F10.** Bucket names rotate at 00:00 UTC, so every per-IP window restarts once a day (≤1 extra window around
  midnight; the 0x hourly quote-build cap is keyed on the same hash). Accepted as the cost of an unlinkable daily salt.
- **F11 (Sentry).** Not initialised anywhere, measured: a production build with a dummy DSN has it in 0 client and
  0 server files, on `origin/main` and here; there is no `instrumentation.ts` / `instrumentation-client.ts`. Written
  down in `docs/security/SENTRY-STATUS.md`, pinned by `sentry-not-initialised.test.ts`. Not enabled. Not verified:
  the Sentry project inbox itself (owner).

## Evidence (filled as measured)
