# Feedback — fix/dca-consent-copy-and-tier-check

**Scope.** Owner-accepted reads outside the list: `next.config.js` (CSP), `security-headers.test.ts`,
`api/orders/route.ts` + `orders-floor-consent.test.ts`, the `orders_floor_tier_consent` migration. Also read, **not
pre-accepted** (please confirm): `DCAPanel.nofeed-fail-closed.test.tsx:292-327` and
`DCAPanel.nofeed-consent.test.tsx:164-181`, read only to re-pin the old copy. The dialog lives at `src/components/dca/`.

## 1. Part-1 tier check — BUG, but not in `dca-floor-tier.ts`
Real `classifyDcaFloorDetailed`, Node, public DefiLlama. The registry is stubbed `registered=false`: V3 is env-only,
and unset it short-circuits to `unpriced`.

| chain | pair | coin key | HTTP | price | conf | tier |
|---|---|---|---|---|---|---|
| 42161 | WETH→AAVE | `arbitrum:0xba5d…7196` | 200, 589 ms | 167.33 | 0.99 | offchain-price |
| 42161 | WETH→UNI | `arbitrum:0xfa7f…f7f0` | 200, 143 ms | 7.557 | 0.99 | offchain-price |
| 8453 | WETH→AAVE | `base:0x6370…814b` | 200, 361 ms | 167.33 | 0.99 | offchain-price |
| 8453 | WETH→UNI | `base:0xc3de…3c83` | 200, 335 ms | 7.557 | 0.99 | offchain-price |

Price ts ~100 s old. Key format, case, the confidence filter and the 3 s timeout are ruled out; ACAO is `*`.
**Root cause.** The dialog's tier is classified in the **browser** (`DCAPanel.tsx:866`). The production CSP
`connect-src` (curl, 2026-10-11) lacks `https://coins.llama.fi`, so the fetch is blocked, returns null, and the tier
is `unpriced` for every token with no feed. The server (no CSP) gets `offchain-price`, and its exact-match rule would
409 the `unpriced` ack (from the code, not observed).
**Fix (owner).** CSP origin + pin; the server accepts an ack ≥ its own tier and persists the server tier;
`floor_ack_tier` not added (no column).
**Follow-ups.** Move classification to a server endpoint so the browser never calls price sources. Unverified: the
no-env RPC fallbacks `arb1.arbitrum.io` and `mainnet.base.org` aren't in `connect-src`; production naming only AAVE
suggests its registry read worked.

## 2. Copy diff (pinned verbatim)
- Heading "How DCA buys are protected" added.
- Both tier texts replaced by the owner's (old: "No on-chain price feed for {S}…" / "No price source for {S}. Buys may
  execute at ANY price…").
- Checkbox "I understand and want to proceed" → "Got it — continue". Buttons unchanged. "A / B" → "A and B".
- Judgment calls: {MAX} = min(effective, ceiling), today's clamp moved inline instead of the "Currently $X" suffix;
  N=1 → "1 token … has".

## 3. {N}
`countRegisteredFeeds` → `readExecutorFeedCoverage` (the classifier's helper) over `getChainTokenList(chainId)`, with
native ETH counted as WETH and deduped. N = legs − unregistered; null when unreadable, no executor or an unsupported
chain. Cached 60 s per chain (successes only), fetched in parallel with the cap; rate limit and `Cache-Control` kept.
The UI renders null, 0 or junk as "A small set of tokens on this network have…".

## 4. Tests (+21)
security-headers +2 · dca-floor-tier +4 (captured AAVE 42161/8453 → offchain-price; CSP-blocked → unpriced; fetched
origin ∈ CSP; floorAckCovers) · orders-floor-consent +3 (stronger ack 201 with server tier persisted; unknown ack 409;
production repro 201; weaker/equal unchanged) · dca-floor-cap +5 (suggested-set count; grows after 60 s, not before;
unreadable → null, not cached; no executor; no Supabase) · DcaFloorConsentDialog 5→12 (exact copy, heading, checkbox,
N from the API, fallback, never "0 tokens", "A and B", submit blocked until checked; cap clamp kept). The 3 DCAPanel
copy pins were re-pinned and `expectNoWalletInteraction` kept. Red checks: CSP revert fails 3, the old route fails 2,
mutating 0 → "0 tokens" fails 2.

## 5. Verification
Suite: 290 files / 4372 tests pass; pristine origin/main is 290 / 4351. Lint: 0 errors / 94 warnings on both, with a
JSON multiset diff of 0 added / 0 removed. `tsc --noEmit` clean. `diff --stat` before this commit: 14 files, +468 / −61.
