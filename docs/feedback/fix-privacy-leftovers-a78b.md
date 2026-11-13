## Feedback: fix/privacy-leftovers-a78b

A78b M and L findings S-8 to S-12 plus the WalletConnect description. Draft PR, Auditor required (Privacy copy, v1 == v2). No PR opened by me. Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/privacy-leftovers-a78b
Layout: one screen of narrative, the content-map, then Evidence 2 to 4 in two lines each; full tables and the per-file stat are in `fix-privacy-leftovers-a78b.evidence.md`.

- [x] C1 copy S-8, S-9, S-10 · [x] C2 S-11 guard, S-12 limiter · [x] C3 WalletConnect description · [x] verify, hosts capture, push
- **Premise false, asked once, owner answer 2026-11-13: "Keep it".** S-10 half 1 ("addresses as they appear on-chain") is not true: the tab shows pair, route, time, tx link; the API cuts each wallet to 6 + 4 characters (`api/analytics/route.ts:468-472`). Section 6 says that. Half 2 is true (`analytics/personal/route.ts:11,47`, `export/route.ts:164,216`).
- **S-9:** the old list named slippage (`SwapBox.tsx:74`), swap history (`useSwapHistory.ts:24`), approvals (`useActiveApprovals.ts:9`) as stored; all three are memory only.
- **S-8, could contradict "Cloudflare in front":** for it `lib/cloudflare-ips.ts:4`, `lib/trusted-ip.ts:23-34`. Against or unproven: `lib/fingerprint-validator.ts:66,100,138`, `lib/monitoring-loop.ts:157` ("pre-Cloudflare-migration"), `FASE-A-CLOUDFLARE-DNS.md:3` "Status: pendente". The dashboard analytics toggle behind "we do not ask them for analytics" is not provable here.
- **Reads:** `api/stats/route.ts` (94 lines) has no wallet or address field, so it needs no copy; `help-content.ts:131-135` carries the 6 and 8 notes through the same constants.
- **Extra reads (not in the allow-list):** `analytics-tracker.ts:162`, `public/sw.js`, `WalletSessionGuard.tsx`, `read-auth.ts`, `lib/trusted-ip.ts`.
- **Found while verifying:** `client-ip-key.guard.test.ts` scanned only `checkRateLimit(` (`expected 14 to be greater than 15`); regex now matches both names, own commit.
- **For the owner:** Cloudflare analytics toggle; `/api/analytics` still returns the shortened wallet plus tx hash (separate change).

### Evidence 1: content-map delta (v1 `LegalPage.tsx` == v2 `LegalPageV2.tsx`; Help and Docs read the same constants)
| where | before | after | proof |
|---|---|---|---|
| 3.3 `PRIVACY_LOCAL_STORAGE_NOTE` (new) | "...imported tokens, slippage settings, swap history, theme preferences, and active approvals." | the keys of Evidence 2; slippage, swap history, approvals "memory only"; wallet libraries' entries "theirs" | `ui/v2/docs-legal/browser-storage-list.test.ts` (writers in `src` == table) |
| 3.3 `PRIVACY_LOCAL_COPIES_NOTE` | "These copies stay in your browser…" | "The copies of your orders and order activity stay in your browser…" | `useOrderEngine.ts:260`, `analytics-tracker.ts:114` |
| 6 `PRIVACY_PUBLIC_ANALYTICS_NOTE` (new) | none | public data; swaps and fills of all users with pair, route, time, tx link; no addresses shown, data holds them shortened (6 + 4); a signed swap is a public transaction; anyone with an address can request its statistics, no signature | `api/analytics/route.ts:38-40,468-472`; `AnalyticsDashboard.tsx:116-134`; `analytics/personal/route.ts:11,47`; `analytics/export/route.ts:164,216` |
| 8 last sentence | "Any data stored in your browser (…) remains on your device." | "What the Interface keeps in your browser is listed in section 3.3." | old one contradicted the order-read signature sent as a header (`read-auth.ts:163,172`) |
| 8 `PRIVACY_PROVIDERS_NOTE` (new) | none | Vercel and Cloudflare process every request including the IP address, under their own policies; we do not ask them for analytics | `vercel.json`, `trusted-ip.ts:23`, `cloudflare-ips.ts:4`, owner fact; no analytics package or script (`package.json`, `layout.tsx`, `privacy-copy.test.tsx`) |
| Help, Docs v1 + v2 | ended at the wallet-storage note | + the 6 and 8 sentences, same constants | `help-content.ts:133`, `DocsPage.tsx:549`, `DocsTabV2.tsx:474` |
| `wagmiConfig.ts:117` `appDescription` | "Ethereum & Base meta-aggregator: best swap price across 11 liquidity sources." | "TeraSwap is an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL} that compares quotes across ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources." | same constants as `SITE_META_DESCRIPTION` (`product-claims.ts:156`); no "best" |

### Evidence 2 to 4 (details and file:line per key in the companion file)
2. **Storage keys** (every writer in `src`; guard `browser-storage-list.test.ts` fails on a new one):
local: `teraswap-theme` `contexts/ThemeContext.tsx:67` · `ts:imported-tokens:v1:<chainId>` `lib/imported-tokens.ts:24,85` · `teraswap:v2:fiat-currency` `ui/v2/fiat/fiat-preference.ts:9,33` · `teraswap:permit2-educated:v1` `components/Permit2EducationModal.tsx:56`, `ui/v2/modals/Permit2Sheet.tsx:23` · `teraswap_notifications_enabled`, `teraswap_notif_prompt_dismissed` `hooks/useOrderNotifications.ts:71,209` · `teraswap_dismissed_orders` `hooks/useOrderEngine.ts:268,286`
local, AES-GCM: `teraswap_orders_v4` `hooks/useOrderEngine.ts:167,260` · `teraswap_analytics_events_v2` `lib/analytics-tracker.ts:39,114`
session: `ts_v2_intro_seen` `ui/v2/landing/Intro.tsx:10,23` · `teraswap:rateInverted` `components/QuoteBreakdown.tsx:89`, `ui/v2/swap/QuotePanel.tsx:13,79` · `teraswap_wallet_connected_at` `components/WalletSessionGuard.tsx:31-32,66,83` · `teraswap:orders-read:<wallet>` `lib/order-engine/read-auth.ts:134,163,172`
other: Cache Storage `teraswap-v1` `public/sw.js:11-24,51-55`; wallet libraries' own entries (`lib/lazy-walletconnect.ts:41,57`); no app cookies. Dead keys (no importer): `teraswap_beta_banner_dismissed`, `teraswap_source_prefs`, `teraswap_analytics_events` (see companion).
3. **S-11:** `useQuote.log-quote.callers.test.ts`; break-it A to D each failed (new `useFoo.ts` with `{ logQuote: true }`: `expected [ { …(2) }, { …(2) } ] to deeply equal []`; `LandingPage.tsx`, v2 `Hero.tsx` imports of the swap screen or `@/lib/analytics`: same failure). **S-12:** hung KV answered 200 in 1007 / 1004 / 1002 / 1005 ms (log-quote, log-swap POST, PATCH, log-activity; bound 1500); 61st request in degraded mode and 121st with KV is 429; old routes failed 12 of 18 tests. **C3:** old string fails 3 tests and the checker.
4. **Verify output** (`scripts/agent-verify.sh --codeql` at 9d23b75, base origin/main 649105f; `git diff 9d23b75..HEAD` is two docs/feedback files only, so not re-run):
```
suite:       PASS 10650 tests passed, 0 failed, 497 files
lint-delta:  PASS errors +0, warnings +0
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: PASS 111 tests passed, 0 failed, 11 files
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new 0
RESULT: PASS
```
Hosts capture (production build): 16 passed. `check-product-claims.mjs`, `gen-claude-state.mjs --check`, `check-agents-parity.mjs`: PASS. Not run: `--keeper`, `goal-lint`.
`git diff --stat origin/main...HEAD` without `docs/feedback/`: 27 files changed, 686 insertions(+), 60 deletions(-); largest `useQuote.log-quote.callers.test.ts` 202, `log-routes.limiter.test.ts` 144, `browser-storage-list.test.ts` 100, `log-routes.hung-kv.test.ts` 83, `privacy-copy.test.tsx` 51, `product-claims.ts` 21, `wagmiConfig.test.ts` 21; the three log routes 4 each. Full per-file stat: companion. Compare link above.
