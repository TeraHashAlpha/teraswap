# feat/retire-force-mev — retire Force MEV, CoW stays an ordinary source (base origin/main 0e0334b, 2026-11-06)

- [x] C0 premise (da649a2)  - [x] C1 toggle out (6f0d95a)  - [x] C2 claims (6ac366c + b5d6b5a)  - [x] C3 monitor (16bac36)  - [x] verify + push

**Owner answers (in-session, supersede the goal):** (a) "Use Gasless Route" CTA — it switched the same hidden CoW-only filter — is
**removed** in v1+v2, the gasless card stays as information. (b) The MEV landing item is **§3 "What Makes TeraSwap Different" item 03**,
not §6 (§6 item 03 = "Statistical Outlier Detection", no MEV); replaced by the **unverified-swap size gate**; §6 01–09 untouched.

## 1 · Commit-0: premise HOLDS
Toggle state was read ONLY by `selectBestWithMevPreference` (`src/lib/mev-preference.ts:41`) = strict filter to `mevProtected` sources
= CoW. Never reached slippage, signing or an RPC; no Flashbots/private-RPC path in `src/`. Smart CoW promotion (15 bps + gasless) = ranking rule, unchanged.

## 2 · Before → after (render probe, same fixture in both trees; v1 / v2 identical in every row)
| Surface | origin/main | branch |
|---|---|---|
| Swap, CoW runner-up + gasless | Force MEV row · "CoW Protocol available for MEV protection. Enable ×" · "Use Gasless Route" · "Your swap is fully MEV-protected." | none of them; "Zero Gas Available" card stays; Best via Velora |
| Swap, CoW best | Force MEV row · "MEV Protected" badge · "fully protected from MEV" · "Est. MEV savings" | gone; "Vs. median quote"; **Best via CoW Protocol** + CoW review (v1 modal, v2 sheet) |
| Landing §3 | 01 Meta-Aggregator · 02 Oracle-Verified · 03 MEV Protection on CoW Routes | 03 **Unverified-Swap Size Gate** ($1,000 warn / $10,000 block — enforced v1 `SwapBox.tsx:651`, v2 `gates.ts:71`) |
| Landing §6 | 01–08 (DCA off in env) | byte-identical |

## 3 · Claims grep proof
`src/config/retired-claims.test.ts` — TypeScript-AST scan of every user-facing string in `src/` (literals, templates, JSX text joined
per element; comments are not surfaces) for MEV-protection phrasing: **origin/main 134 hits in 20 files → branch 0**; positive/negative
controls keep it non-vacuous. `MEV_PROTECTION_CLAIM = { live: false, retiredOn: '2026-11-06', reason }` in product-claims.

## 4 · Monitor
| Signal | Before | After |
|---|---|---|
| H1 probe 429 | `ok` (status < 500) → green | `rate-limited` → **degraded** (quiet), never counts toward `disabled`, never `active` while seen |
| Quote path 429 (H5 quorum, breaker `lastFailureStatus`) | invisible | same episode, `via: quote`; a returned quote clears it |
| Tick / daily report | nothing | `[SOURCE] cowswap: rate-limited (429) since <first seen>` (tick `rateLimited`, `/api/monitor/status.rateLimitedSince`, ⚠️ row) |
| Alert | none | after 30 min, 1 h cooldown, recovery message (only if alerted) — `emitTransitionAlert` |

Mocked 429 (two calls → ONE line): `{"event":"cow_quote_429_first","status":429,"retryAfter":"30","headers":{"retry-after":"30",
"x-ratelimit-limit":"10","cf-ray":"8d9a1b2c3d4e5f60-IAD","server":"cloudflare"},"region":"iad1","endpoint":"https://api.cow.fi/mainnet/api/v1/quote","body":"{…≤200…}"}`

## 5 · Verify
Suite 447 files / **7897 pass** (origin/main 440 / 7843 pass, +54) · lint 0 err, warnings 93 → 92 (−1 set-state-in-effect) · tsc clean ·
`next build` OK · parity sweeps green (stale `×` glyph allow entries dropped) · rpc-budget 33/33 · claims checker 0 · CodeQL
security-extended 13 → 13, **0 new**. `git diff --stat`: 58 files, +1584 / −470.
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/retire-force-mev

**For the Auditor:** quote-path flag removal (`mev-preference` 2nd arg ignored, deprecated). `degraded` force-opens the CoW breaker on a
cold lambda (`initFromKV`, pre-existing for every degraded source) → CoW skipped ≤ 60 s, then probed. The 429 rule applies to every probed
aggregator. Kept as data, not copy: `AGGREGATOR_META.cowswap.mevProtected` (drives the ranking rule), public API `meta.mevProtected`,
DB `mev_protected` — owner may want the API field deprecated. Extra reads beyond the list (needed for "every consumer" / the monitor):
SwapButton, CowOrderReviewModal, LandingPage, LandingBelowFold, useSwap (error string), constants, api, layout, wagmiConfig,
source-state-machine, circuit-breaker, alert-wrapper, status route, daily-health-report.yml, check-product-claims. Pre-existing, untouched:
wagmiConfig "Ethereum & Base … 11 sources"; help-content "Permit2 for gasless approvals" contradicts the Docs.

## Content-map delta — removed in v1 AND v2, reason: owner decision 2026-11-06 (CoW 429 since 2026-10-29, no paid tier)
| Removed | Replacement |
|---|---|
| "Force MEV Protection" toggle + tooltip "Always route through CoW Protocol regardless of price…" + aria "Toggle force MEV protection" | — |
| "No MEV-protected quote available. CoW Protocol may be temporarily unavailable. Try disabling Force MEV Protection…" | — |
| "CoW Protocol available for MEV protection." + "Enable" + "×" (aria "Dismiss MEV protection hint") | — |
| "Use Gasless Route" + "or keep current" (owner answer) · " Your swap is fully MEV-protected." | card text unchanged otherwise |
| "MEV Protected" badge (best) · "MEV" badge (Compare rows, source lists) | — |
| "(MEV protected)" · "· auto-selected for MEV protection" + title "…within 0.3%… for MEV protection." | "(gasless)" · "· auto-selected (gasless)" + title from `SMART_COW_THRESHOLD_PCT` (0.15%) |
| " Your trade is fully protected from MEV (frontrunning, sandwich attacks)." | — |
| "Est. MEV savings" + title "…what MEV bots could have extracted…" | "Vs. median quote" + neutral title |
| "Your order is MEV-protected. Solvers are competing…" | "Your order is in CoW Protocol's batch auction. Solvers are competing…" |
| "Review MEV-Protected Order" · "✓ MEV-protected via CoW Protocol — …shielded from frontrunning/sandwich attacks…" | "Review CoW Protocol Order" · "✓ Settled via CoW Protocol — solvers compete in a batch auction…" |
| "This MEV-protected order expired…" · route label "CoW Protocol (MEV Protected)" | "This CoW Protocol order expired…" · "CoW Protocol" |
| Landing hero "…and offers MEV-protected routes via CoW Protocol." · §3 03 "MEV Protection on CoW Routes" | hero ends at "…Chainlink oracles." · §3 03 size gate |
| Landing security "MEV bots never sleep…" · "MEV-protected CoW routes. Proxied RPC…" | "Every quote is checked before you sign…" · "Oracle-checked quotes. Proxied RPC…" |
| Docs: overview CoW clause, tag "MEV protection on CoW routes", CoW card clause, security item "MEV Protection", "How TeraSwap protects you", "Why meta-aggregation matters", "We don't claim zero MEV — we claim…", order-engine "MEV-protection path", roadmap "MEV protection via CoW Protocol" | section "MEV & CoW Protocol" (id `mev`): "What is MEV?" verbatim + "CoW Protocol is an ordinary source" |
| Meta: description "MEV-protected routing via CoW Protocol", keyword "MEV protection", WalletConnect ", with MEV protection" | — |
