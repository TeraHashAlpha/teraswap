# Feedback — fix/user-ip-privacy

Base: origin/main `fabaa30`. Recon: `docs/feedback/recon-user-ip-privacy.md` (origin/recon/user-ip-privacy `482f309`).
Owner goal: "this site never sends the user's IP to a third party" is TRUE for everything the site controls, and the
copy says plainly what the wallet does on its own. DRAFT PR, Auditor required (RPC proxy + rate limiting).

## Checklist
- [x] C1 L2 reads through `/api/rpc?chainId=` (wagmi + clients.ts), allow-list, batch cap, per-call limit, 1–2 s cache
- [ ] C2 imported-token + portfolio logos → `/api/token-logo`; WalletConnect page-load telemetry/config off
- [ ] C3 CSP: connect-src 'self' + exact wallet hosts; img-src 'self' data: blob:; remotePatterns dropped; CI capture job
- [ ] C4 rate-limit keys + log lines use HMAC(IP, daily salt); four raw-XFF routes → trustedClientIp; Sentry statement
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

## Evidence (filled as measured)
