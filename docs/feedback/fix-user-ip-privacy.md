# Feedback — fix/user-ip-privacy

Base origin/main `fabaa30` · signed commits, one per goal commit + this file · DRAFT PR, Auditor required (RPC proxy + rate limiting)
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/user-ip-privacy

**Checklist** — [x] C1 `3ec1c04` L2 reads → `/api/rpc?chainId=`, per-chain read allow-list, 1.5 s cache, upstream
`serverRpcUrl` · [x] C2 `03dc179` logos → `/api/token-logo`, WalletConnect modal connector lazy · [x] C4 `963751b`
keys + logs = HMAC(IP, daily salt), four raw-XFF routes, Sentry stated off (ahead of C3, which waited on answer 1) ·
[x] C3 `a298b73` CSP 'self' + 4 wallet sources, img-src, remotePatterns, Supabase socket removed, CI job ·
[x] C5 `1b63998` copy v1 == v2 · [x] Verify · [x] Evidence 1–6

**Owner answers (in session, 2026-11-06 — supersede the goal text)**
1. Supabase Realtime socket in the browser (the recon missed it): **remove**, widen the order poll — done in C3.
2. Copy: the recon's wording was chat-only, so the owner supplied it. Used **verbatim, 0 owner sentences changed**.
3. Proxy upstream with `RPC_URL_<id>` unset: **keep the #628 order** (deprecated `NEXT_PUBLIC_*` as server-only fallback).

**Owner must do before production**
- Vercel (Production + Preview): set `RPC_URL_8453`, `RPC_URL_42161` (they now carry every L2 read) and `RATE_LIMIT_SALT`
  (32+ random chars; unset ⇒ limits hold per instance, not fleet-wide); then delete `NEXT_PUBLIC_{BASE,ARBITRUM}_RPC_URL`.
- Preview, real wallet: WalletConnect QR + its own modal, MetaMask without the extension (headless stops at a mock relay).
- Repo variables `NEXT_PUBLIC_{BASE,ARBITRUM}_FEE_COLLECTOR` must exist for the new CI job (v2-mobile-parity needs them too).

**Findings**
- F1 pre-existing: on `main` a WalletConnect session that includes Ethereum throws while its provider is built — wagmi
  hands it the relative `/api/rpc`. Reproduced vs universal-provider 2.21.1; fixed with an absolute same-origin URL on
  all three chains (the one mainnet-transport change). Not observed on prod.
- F2 AppKit analytics has no init switch on this path ⇒ lazy connector + CSP. My C2 connector broke "open WalletConnect's
  modal" (RainbowKit calls `getChainId()` first); the wallet spec caught it, fixed in C3.
- F3 `NEXT_PUBLIC_RPC_URL` (mainnet) is still inlined in 1 client chunk, never called by the browser. Out of scope.
- F4 owner call: `frame-src 'none'` refuses WalletConnect Verify's iframe (before and after) — wallets may say "unverified".
- F5 `/api/rpc` 300/min per IP now covers three chains; per-IP windows restart at 00:00 UTC; order updates are ≤10 s later.
- F6 not touched: Privacy §3.3 says swap history "is never transmitted to our servers" (true of the localStorage copy)
  next to §3.2's new "we store swap history"; §8's unchanged "no cookies for tracking" rests on Vercel's documentation.
- F7 read beyond the list (to change or verify): the RPC helpers `/api/rpc` imports, `chains/registry`, `adapters/shared`,
  `tokens.ts`, `usePortfolio`, `useTokenImport`, `order-engine/supabase.ts`, `useOrderEngine`, `providers`/`layout`,
  `e2e.yml` + the v2 mobile rig, the claims checker, and the wagmi / RainbowKit / WalletConnect / Reown sources.

**Evidence**
1. Hosts the browser contacts — one spec (`e2e/third-party-hosts`: real Chromium, real CSP, prod build), both builds, v1 = v2:

| scenario | origin/main | this branch |
|---|---|---|
| no wallet · Ethereum | `pulse.walletconnect.org` POST /e, `api.web3modal.org` GET /appkit/v1/config | **none** |
| no wallet · Base / Arbitrum | those two + `base-` / `arb-mainnet.g.alchemy.com` POST ×2 | **none** (`/api/rpc?chainId=` ×2) |
| extension wallet, 3 chains + tabs | those two on every load, Alchemy ×8–10 per L2, `wss <project>.supabase.co` | **none**, CSP refused 0 |
| WalletConnect chosen | not measurable (fails at load) | `wss relay.walletconnect.org`; `api.web3modal.org` once its modal opens; CSP refused pulse ×3, verify iframe ×2, Google Fonts ×1; 0 page errors |
| client chunks | L2 key in 2 files each, Supabase URL + anon key in 1 | **0** |

   main fails 6/6 + 4/4 + bundle; branch **11/11**; `/api/rpc` refused 0 methods the app sent.
2. Proxy: `api/rpc/route.test.ts`, `rpc-method-policy`, `rpc-short-cache`, `wagmiConfig.browser-transports` (no transport
   URL has a provider host with the envs set), `rpc-env.guard`; rpc-budget tables identical to main. Cost — estimate,
   list prices from memory, not measured: 1 Vercel invocation + 4 Upstash commands per call ≈ $0.06–0.10 + $0.80 per
   100k calls; a wallet tab makes ≤6 calls/min ⇒ 1,000 wallet-hours/day on L2 ≈ 360k calls ≈ $3.2/day. Provider
   compute units unchanged.
3. CSP: connect-src 30 sources → `'self' wss://relay.walletconnect.org https://api.web3modal.org
   https://metamask-sdk.api.cx.metamask.io wss://metamask-sdk.api.cx.metamask.io`; img-src → `'self' data: blob:`
   (`csp-policy.js`, reason per source). CI job `third-party-hosts` in `e2e.yml`, pinned by a test.
4. HMAC: `client-ip-key.test.ts` (construction, UTC rotation, two instances agree with the salt / differ without),
   `client-ip-key.routes.test.ts` (real limiter: keys `ratelimit:<route>:<32 hex>`; Redis down ⇒ no address in any log
   line; spoofed XFF keeps the bucket), a static guard. Sentry: `docs/security/SENTRY-STATUS.md` + test.
5. Copy: delta below; `privacy-copy.test.tsx` — v1 and v2 §3.2/§5/§8 and Docs Privacy identical; claims checker green.
6. Suite 440 files / 7843 → **452 / 8079**, 0 failures · lint 0 errors / 93 warnings both, per-rule delta none · `tsc`
   clean · build green (34/34) · CodeQL security-extended 13 → 13, **0 new** · `diff --stat`: 81 files, +3765 / −366.

## Content-map delta (every sentence; owner wording = O1–O5, verbatim)
- **O1** TeraSwap's server relays all RPC reads on Ethereum, Base and Arbitrum, every aggregator quote and swap request, and token logos, so those providers see our server's IP address, not yours.
- **O2** Your wallet's own RPC connection and the transactions it broadcasts are outside our control; the WalletConnect relay sees your connection once you choose a WalletConnect wallet.
- **O3** Use a privacy RPC in your wallet settings if that matters to you.
- **O4** We do not store IP addresses in our database; our hosting and rate-limiting layers process them transiently, and our rate limiter only ever sees a one-way hash.
- **O5** We do store wallet addresses for orders, swap history and activity.

| Surface (v1 = v2) | Before | After |
|---|---|---|
| claims `PRIVACY_PROXY_CLAIM` (Docs overview + card, landing) | RPC reads and aggregator quote requests are routed through a server-side proxy, so those providers see our server's IP rather than yours. | O1 |
| claims `PRIVACY_DIRECT_NOTE` (same places) | Token logos and your wallet's own connection are requested directly by your browser, and the client falls back to direct RPC if the proxy is unreachable. | O2 |
| Help · How does TeraSwap protect my privacy? | All blockchain reads (balance checks, price feeds, transaction receipts) and aggregator API calls are routed through a server-side privacy proxy. Your IP address is never exposed to RPC providers like Alchemy or external DEX APIs. Only our server communicates with these services. | O1 O2 O3 |
| Help · What data does TeraSwap collect? | Minimal. We do not track wallets, store private keys, or collect personal information. Your IP address is actively protected by our privacy proxy. See our Privacy Policy for full details. | We do not store private keys. O4 O5 See our Privacy Policy for full details. |
| Docs · Privacy intro | TeraSwap implements a privacy-preserving architecture that protects users' IP addresses from external blockchain infrastructure providers and aggregator APIs. | O1 |
| Docs · 01 RPC Privacy Proxy | All on-chain read operations from the browser are routed through a server-side proxy (/api/rpc) instead of directly calling RPC providers. Only our server's IP is visible to the third-party RPC providers while the proxy is reachable (see Graceful Degradation). | *(mine)* All on-chain read operations from the browser, on {chain list}, are routed through a server-side proxy (/api/rpc) instead of directly calling RPC providers. The RPC provider sees our server's IP address, not yours. There is no direct fallback: if the proxy is unreachable the read fails rather than going around it. |
| Docs · 02 API Proxy Layer | …Quote and swap requests do not go directly from your browser to these services. | unchanged + *(mine)* Token logos are fetched by our server too and served from our own address. |
| Docs · 03 | **Method Policy (Blacklist)** — The RPC proxy relays every read method by default and explicitly blocks only signing/transaction methods (…). A blacklist is used deliberately — a method whitelist devolves into whack-a-mole. Your wallet still signs and broadcasts transactions itself; the proxy never sees your keys. | *(mine)* **Method Policy (Read-Only Allow-List)** — The RPC proxy relays only a fixed list of read-only methods per chain (balances, contract calls, receipts, blocks, fee data, logs) and refuses everything else, including every signing or transaction method (…same list). Your wallet still signs and broadcasts transactions itself; the proxy never sees your keys. |
| Docs · 04 Rate Limiting | 300 requests per IP per minute on the RPC proxy to prevent abuse. The swap endpoint is limited to 20 requests per minute. | unchanged + O4 |
| Docs · 05 | **Graceful Degradation** — If the privacy proxy is unreachable, the client falls back to direct RPC. Privacy is never a single point of failure — connectivity takes priority. | **What We Cannot Relay** — O2 O3 |
| Docs · table | 5 rows | + `Token logos · /api/token-logo · Yes` |
| Docs · Note | Your wallet's own RPC connection (MetaMask, Coinbase Wallet, etc.) and transaction signing are handled by your wallet directly and are not proxied. For maximum privacy, configure a privacy-focused RPC in your wallet settings (e.g., MEV Blocker, Flashbots Protect). + old direct note | O2 O3 O5 |
| Privacy §3.2, last sentence | We do not collect or store your name, email address, IP address, home address, or date of birth. | We do not collect or store your name, email address, home address, or date of birth. O4 O5 |
| Privacy §5 ¶1 | TeraSwap implements a server-side privacy proxy that shields your IP address from external services. All blockchain read operations (…) and all aggregator API requests are routed through our server-side proxy. Only our server communicates with third-party RPC providers and DEX APIs — your browser never makes direct requests to these services. | O1 |
| Privacy §5 ¶2 | **What is protected:** Token balance checks, ERC-20 allowance reads, transaction receipt polling, Chainlink price feed queries, custom token imports, and all swap/quote requests to aggregator APIs (1inch, 0x, CoW Protocol, etc.). | **What is relayed:** same list with "token logos," added |
| Privacy §5 ¶3 | **What is not protected (by design):** Your wallet's own RPC connection (MetaMask, Coinbase Wallet, etc.) is controlled by your wallet settings. Transaction signing and submission are handled by your wallet directly. We recommend using a privacy-focused RPC in your wallet settings (e.g., MEV Blocker, Flashbots Protect) for maximum privacy. | **What is not relayed (by design):** O2 O3 *(mine)* The same is true of any other connection service your wallet uses: for example MetaMask's, if you pair the MetaMask mobile app from a browser without the extension, and Reown's wallet directory, if you open WalletConnect's own wallet list. |
| Privacy §8 | The Interface does not use cookies for tracking or advertising purposes. We do not employ any third-party analytics or advertising scripts. Any data stored in your browser (via localStorage) is used solely for your convenience and remains on your device. | The Interface does not use cookies for tracking or advertising purposes, and it runs no advertising scripts. *(mine)* Page views are counted by Vercel Web Analytics, our hosting provider's analytics, which is loaded from our own domain. No third-party error-reporting or session-replay service runs in your browser. Any data stored in your browser (…) — unchanged. |

---

## A76 fixes (Auditor A76 on #668 at `014174c`: blocked 0C/2H) — task checklist

Merged `origin/main` first: already up to date at `7eeefeb` (main `838628c`), no merge commit. One commit per id, each
with a test that fails on `7eeefeb` (run in a detached worktree at that commit). #668 stays a draft.

- [x] S-1 (H) browser never calls api.cow.fi — `/api/cow/{quote,orders,order-status,trades}` behind the limiter; v1/v2
      submit + poll and the LimitOrderPanel price read through them; CI capture "CoW submit after signing"; copy fixed
- [x] S-2 (H) Privacy §3.3 — Auditor's sentence, v1 == v2, content-map delta
- [ ] S-3 (M) `/api/rpc` — drop eth_getLogs / eth_simulateV1 / eth_getProof / eth_createAccessList; 10 s upstream
      timeout; byte-capped read, > 4 MB → 502
- [ ] S-4 (M) IPv6 rate-limit keys hash the /64
- [ ] S-5 (L) `/api/rpc` limiter bounded at 1 s
- [ ] S-6 (L) order poll by the locally active order hashes, not the 50 newest rows
- [ ] S-7 (L) empty JSON-RPC batch → −32600
- [ ] Verify: suite, lint delta 0, tsc, build, host capture incl. CoW, rpc-budget, CodeQL 0 new, gitleaks

### A76 content-map delta (v1 = v2 everywhere; Auditor wording verbatim for §3.3)

| Surface | Before | After |
|---|---|---|
| `PRIVACY_PROXY_CLAIM` (Docs overview + card + Privacy intro, landing, Help, Privacy §5 ¶1) — S-1 | …every aggregator quote and swap request, and token logos, so those providers see our server's IP address, not yours. | …every aggregator quote and swap request, **every CoW Protocol order you sign and its status checks,** and token logos, so those providers see our server's IP address, not yours. |
| Docs · Privacy · 02 API Proxy Layer — S-1 | …proxied server-side through /api/quote and /api/swap. Quote and swap requests do not go directly from your browser to these services. … | …proxied server-side through /api/quote and /api/swap, **and a CoW Protocol order you sign is submitted and tracked through /api/cow. Quote, swap and order requests** do not go directly from your browser to these services. … |
| Privacy §6 ¶1 — S-1 | When you request a swap quote, the Interface sends your wallet address and transaction parameters to the APIs of third-party aggregator and DEX protocols via our server-side proxy. Your IP address is not exposed to these services. … | When you request a swap quote, **or submit a CoW Protocol order you have signed,** the Interface sends your wallet address and transaction parameters **(for a CoW Protocol order, the signed order itself)** to the APIs of third-party aggregator and DEX protocols via our server-side proxy. Your IP address is not exposed to these services. … |
| Privacy §3.3, last sentence — S-2 (`PRIVACY_LOCAL_COPIES_NOTE`) | This data remains exclusively on your device and is never transmitted to our servers. | These copies stay in your browser and are never uploaded as such; separately, every swap and order you make is sent to our server and stored with your wallet address (see 3.2) — that server record is what the History tab shows. |
| `csp-policy.js` header comment (not user-facing) — S-1 | Aggregator / DEX APIs (…CoW…): called by our API routes, never by the page. | + the signed order, its status and trades go to /api/cow/*, the limit price to /api/cow/quote; before A76 the page POSTed to api.cow.fi itself. |
