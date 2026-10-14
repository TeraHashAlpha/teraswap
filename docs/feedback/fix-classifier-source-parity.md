## Feedback — fix/classifier-source-parity (Commit 1: facts — STOPPED here, premise false)

**Auditor-note: consent tier gate (fund-adjacent). No source changed. The owner's answer to the Q in §5 supersedes the goal text.**

### Checklist
- [x] Worktree `~/ts-worktrees/classifier-source-parity` off origin/main `dd1dffa`, real `npm ci` (exit 0)
- [x] Commit 1 — facts (this file) · [ ] Commit 2 — parity · [ ] Commit 3 — tests ← **STOPPED: the keeper also fails quorum** (goal §Commit 1 (c)); owner confirmed "Stop here" (§5)
- [x] Reads outside the list, recorded: `git log` (history only); `head -30 docs/feedback/sprint-p1b-limit-tp-v3.md` (format); live GETs: Chainlink `feeds-ethereum-mainnet-base-1.json`, CoinGecko `coins/uniswap`

### 1. Facts
**(a) Live 2026-10-14T14:27:40Z, UNI/Base `0xc3De…3C83`**
- DefiLlama `coins/prices/current/base:0xc3de…` → HTTP 200 `{"coins":{"base:0xc3De…3C83":{"decimals":18,"symbol":"UNI","price":7.180169859710549,"timestamp":1791988026,"confidence":0.99}}}` (34 s old ⇒ fresh, counts).
- CoinGecko `simple/token_price/base?contract_addresses=0xc3de…&vs_currencies=usd&include_last_updated_at=true` → HTTP 200 `{}` (absent). Structural, not transient: `coins/uniswap` (14:30:44Z) `platforms` = ethereum, arbitrum-one, optimistic-ethereum, polygon-pos, unichain, … — **no `base`**.

**(b) Does the keeper's Chainlink source cover UNI on Base? NO.**
- `price-sources.js:83-92` `CHAINLINK_USD_FEED_BY_CHAIN[8453]` = WETH, DAI, USDC, COMP, EURC, USDT, VIRTUAL, cbBTC — no UNI. "UNI / USD" exists only under 42161 (`:108`, `0xfa7f…7f0 → 0x9C91…2720`).
- `price-sources.js:283-289` `if (!feed) { const m = CHAINLINK_USD_FEED_BY_CHAIN[Number(chainId)]?.[addr]; if (!m) return null; … via = "mirror" }` ⇒ no entry ⇒ chainlink absent, no read.
- App side (what the mirror copies, drift-pinned): `chainlink-feeds.ts:55-76` `CHAINLINK_FEEDS_BY_CHAIN[8453]` = WETH, DAI + `registeredFeedMap(8453)`; `dca-feed-registrations.json` 8453 rows = USDC, WETH, AERO, COMP, DEGEN, EURC, MOG, MORPHO, USDT, VIRTUAL, WELL, YFI, ZRO, cbBTC, cbETH — no UNI. The file's only "UNI / USD" (`:466`, feed `0x5533…20e`) is the **mainnet** FEED_EXPECTATIONS row.
- Chainlink's own Base directory (188 feeds, 14:29:02Z): **no UNI/USD feed exists on Base** (only "uniBTC / BTC Exchange Rate"). Nothing to mirror, nothing to register.

**(c) WETH→UNI on Base today**
- Keeper, UNI leg: chainlink ✗ (V3 `tokenUsdFeeds` `registered:false` — the symptom's own answer, same read; not ETH-priced `:277`; no mirror `:284-285`), defillama ✓, coingecko ✗ ⇒ **1 source ⇒ `single`** (ADR-024 quorum table L74: tighter band, fill ≤ $250 cap, flagged; chunk above cap delayed). `combineLegModes` = single if either leg is single (ADR-024 L80-82) ⇒ pair is `single` whatever WETH does. **No quorum.**
- Web classifier, UNI leg: defillama ✓, coingecko ✗ ⇒ `offchainQuorumPrice` null ⇒ **`unpriced`** ⇒ UI "buys capped at $250".
- ⇒ Keeper and classifier **agree** (`single` ⇔ `unpriced`, same $250 cap). Hypothesis false. Commit 2 as specified (add Chainlink to the classifier) would leave UNI/Base identical: there is no Chainlink entry on either side.
- Why `offchain-price` two days earlier: until `dca-price-quorum.ts` (48dbc5d 2026-10-11 14:03 WEST, merged #561 `e4b2def` 18:31 WEST) the tier was granted on ONE DefiLlama answer (`dca-price-quorum.ts:7-8`). The flip is #561's intended effect, not a regression. Prod deploy time of #561 not verified (no Vercel reads in scope).

### 2–4. Parity module / test matrix / live re-check — not done (stopped at (c))
- Phase-1 repro, PRODUCTION module + live sources (`quorumPriceUsd`, scratch vitest outside the tree): 2026-10-14T14:34:37Z → `quorumPriceUsd(UNI,"base")` = **null ⇒ unpriced**; control `quorumPriceUsd(AAVE/Base 0x6370…814b,"base")` = 155.7 ⇒ offchain-price; 4 requests, origins `coins.llama.fi` + `api.coingecko.com` only.
- Residual gap that IS real (owner's call, not the symptom): a token in the mirror but NOT V3-registered (Arbitrum, V3 not operational: AAVE, ARB, COMP, CRV, LDO, LINK, MAGIC, PENDLE, SUSHI, UNI, WBTC; Base: whichever of DAI, COMP, EURC, USDT, VIRTUAL, cbBTC is not yet registered) gives the keeper a 3rd source the classifier never asks. It changes the tier only when CoinGecko is absent for that address AND the Chainlink quote is < 600 s old (ADR-024 L124-127: long-heartbeat feeds are usually absent).

### 5. Verification · Q for the owner
- `git diff --stat` vs origin/main = this file only, so every test/lint/tsc input equals origin/main. On this tree: `npm test` 299 files / 4452 passed / 0 failed; `npm run lint` 0 errors / 93 warnings (budget 94); `npm run typecheck` 0 errors. Focused: `dca-price-quorum` + `dca-floor-tier` + `dca-floor-cap/route` tests → 54 passed.
- **Q (blocked Commit 2/3):** UNI/Base cannot reach quorum anywhere (no Chainlink feed, no CoinGecko mapping) — (1) parity module anyway (mirror-covered tokens only)? (2) accept `unpriced` ≡ keeper `single` and change copy/expectation elsewhere? (3) other (consented single-source tier)?
- **Owner's answer (2026-10-14, in-session, supersedes the goal text): "Stop here"** — (2): `unpriced` ≡ keeper `single` for UNI/Base is correct; this branch stays facts-only; any copy/expectation change is a separate prompt. Commit 2/3 not built.
- Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/classifier-source-parity
