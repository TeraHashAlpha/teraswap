# Feedback — recon/user-ip-privacy (READ-ONLY recon, no source edits)

Owner question: is the user's IP hidden from third parties on teraswap.app? Help copy says "IPs never exposed" (backlog 68).
**Answer: no.** Mainnet RPC reads and every aggregator call are proxied. Base/Arbitrum RPC reads, WalletConnect/Reown
(config + telemetry, at page load, every visitor) and imported-token logos go straight from the user's browser.

## Task checklist
- [x] Branch `recon/user-ip-privacy` cut from `main`; no source file touched (`git status` clean apart from this file)
- [x] Read scoped files (wagmiConfig, rpc*, chains/**, /api/rpc, /api/token-logo, next.config.js CSP, sw.js, Sentry/analytics/WC init, usePortfolio, Docs/Legal/help)
- [x] Headless Chromium host capture: prod build, `next start`, v1 (`UI_V2_ENABLED` unset) and v2 (`=true`), Ethereum/Base/Arbitrum, disconnected + EIP-6963 mock wallet. Every non-localhost request was recorded and stubbed — nothing left this machine
- [x] Server-side IP handling · [x] claim-by-claim verdicts · [x] report in chat

## Hosts the BROWSER contacts (measured = M, code-derived = C)

| host | for / trigger | receives | chains · v1/v2 | via our server? | fix · effort |
|---|---|---|---|---|---|
| `pulse.walletconnect.org` POST `/e` (M) | Reown telemetry `INITIALIZE`, **page load, no wallet** | IP, UA, origin/referrer, projectId, chain list, app metadata | all · v1+v2 | **no** | CSP exact-host list without `pulse.*`, or AppKit analytics off (spike: is it non-fatal when blocked?) · S–M |
| `api.web3modal.org` GET `/appkit/v1/config` (M) | AppKit remote config, page load | IP, UA, origin, projectId | all · v1+v2 | **no** | lazy-load wallet connectors until "Connect" · M |
| `base-mainnet.g.alchemy.com` or whatever `NEXT_PUBLIC_BASE_RPC_URL` is (M, dummy host) | RPC reads: `eth_chainId` guard, balances, oracle, block poll | IP, UA, calldata (token addrs; wallet addr when connected), **the key (in bundle)** | Base · v1+v2 | **no** | wagmi + `clients.ts` → `/api/rpc?chainId=8453` · S (+ budget tests) |
| `arb-mainnet.g.alchemy.com` / `NEXT_PUBLIC_ARBITRUM_RPC_URL` (M) | same | same | Arbitrum · v1+v2 | **no** | → `/api/rpc?chainId=42161` · S |
| `tokens.1inch.io` (C) | `<img>` for **imported** tokens (`importedTokenLogo`, `useTokenImport`), portfolio fallback `logo1inch` | IP, UA, token address | Eth (path is address-only) · v1+v2 | **no** | point both at `/api/token-logo` · S |
| `relay.walletconnect.org` wss, `explorer-api.walletconnect.com`, MetaMask SDK, Coinbase (C) | only after the user picks that wallet / opens "All wallets" | IP + encrypted relay traffic | all | no | **cannot** — wallet connection, by design |
| wallet's own RPC + tx broadcast | every read the wallet makes, every send | IP, address, tx | all | no | **cannot — wallet's own RPC** |
| `debank.com`, `revoke.cash`, explorers (C) | user clicks a plain `<a>` (no prefetch); Referer = origin only | IP, wallet address in URL | all | no | **cannot** (user navigation); label as external |
| `*.ingest.sentry.io` (M) | **not initialised today**: dummy DSN absent from every `.next` chunk; no `instrumentation-client.ts`; `sentry.client.config.ts` is only injected by the webpack path, build is Turbopack | — | — | — | decide: leave off, or `instrumentation-client.ts` + `tunnelRoute` · S–M |
| fonts / service worker / Vercel Analytics (M) | fonts self-hosted (`next/font/local`), **0** font hosts. SW fetches same-origin only (cross-origin images merely pass through it). `/_vercel/insights/*` is same-origin | — | — | yes (our origin) | none · — |

Same hosts on v1 and v2, disconnected and mock-connected; no additional third-party host appeared on connect. Token logos otherwise
go through `/api/token-logo` (101 same-origin requests per run, 0 to CoinGecko/DefiLlama/GitHub).

## Findings / concerns
- **CSP is wider than usage.** `connect-src` still allows 1inch, 0x, Paraswap, Kyber, CoW, OpenOcean, Sushi, Balancer, Infura, Alchemy, Ankr, Publicnode, Merkle, Etherscan, Supabase; `img-src` allows `tokens.1inch.io`. The browser *may* call all of them; today it calls none except via the rows above. Defaults `mainnet.base.org` / `arb1.arbitrum.io` are **not** in the CSP, so L2 reads work in prod only because the env URL is Alchemy — whose key is public by construction (`NEXT_PUBLIC_*`).
- **Asymmetry, why:** `/api/rpc` was built mainnet-only; `?chainId=` arrived in SPRINT-9P for token import and was never wired into wagmi (`wagmiConfig.ts:130-136` stays direct, "[P219] public RPC for now").
- **Proxying L2 costs ~nothing in Alchemy CU** (same calls, same key). It adds Vercel invocations + 4 Upstash commands/call (rate limit). Estimate, not measured: 100k L2 calls/day ≈ $0.06 Vercel + ≈ $0.80 Upstash. Mitigate with a 1–2 s per-instance cache for `eth_chainId`/`eth_blockNumber`.
- **Docs "Graceful Degradation" is false for mainnet:** the browser has no direct fallback (`wagmiConfig.ts:33-46`); on L2 direct *is* the default. `product-claims.ts` comment still says token-logo 302s (stale since C8).
- **Server side:** `trustedClientIp` returns the **raw** IP → Upstash key `ratelimit:<route>:<ip>` with `EXPIRE` = window (60 s); on KV outage `console.warn` prints the key (raw IP) to Vercel logs — observed locally (`token-logo:::1`). `forLog` only strips control chars. `portfolio/tokens|prices`, `oracle-coverage`, `admin/kill-switch` still read raw left-most XFF. Supabase schema has **no IP column**; it does store wallet (`swaps`, `wallet_activity`), `session_id`, `user_agent` ≤500 chars. Vercel request-log retention is plan-dependent — not verifiable from the repo (owner: dashboard). Cloudflare (if proxied) sees IPs too.

## Not verified (owner)
- Prod `NEXT_PUBLIC_BASE_RPC_URL` / `…ARBITRUM…` values: grep the public chunks for `g.alchemy.com`. I used dummy Alchemy URLs.
- Whether Sentry events actually arrive in prod (same toolchain ⇒ likely dead).
- Mock-connected L2: header stayed "Ethereum", so L2 call volume while connected (27–29 vs 5 disconnected per ~16 s) is an upper-bound sample. WC `pulse` bodies for connect events not captured.
- Read beyond the allow-list (disclosed): `src/lib/trusted-ip.ts`, `kv-rate-limiter.ts`, `log-sanitize.ts`, `body-limit.ts` (grep/targeted), `src/config/product-claims.ts` (claim constants), `supabase/schema.sql` (grep), `src/app/providers.tsx` (grep), `src/components/TokenLogo.tsx`, `ChainSelector.tsx`, `src/proxy.ts`, `ui-cookie.ts` (to drive the rig). Needed to answer the server-side + claims questions.
- Rig note: `UI_V2_ENABLED` must be exactly `true`; `1` silently gives v1.
