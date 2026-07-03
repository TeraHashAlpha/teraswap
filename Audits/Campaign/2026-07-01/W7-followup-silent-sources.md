# W7 follow-up — Silent sources investigation (READ-ONLY)

> **Campaign:** T-SAF 2026-07-01 · **Packet:** `docs/Prompts/INVESTIGATE-SILENT-SOURCES.md` · **Runner:** Auditor
> (read-only) · **Executed:** 2026-07-03. **Baseline:** `origin/main` = `d8c2b3ae31ec496daeae412dd5d5f8db2f02caa7`
> (post-#256). **Zero changes:** no code, no env, no on-chain tx — evidence is code reads on main, prod env
> **names** (`vercel env ls production`), live upstream probes (HTTP status + error body only), live prod
> `/api/quote` samples, monitor/daily history, and on-chain **view** calls. **No secret value was printed,
> logged, or committed** (an attempted `vercel env pull` was blocked by the sandbox policy and NOT retried —
> key *validity* below is proven behaviourally or flagged owner-confirm).

## Verdict summary

The five silent sources have **four distinct root causes — none of them the suspected on-chain whitelist gap**:

| # | Source | Chain | Cause (packet taxonomy) | Evidence (condensed) | Fix-type |
|---|--------|-------|--------------------------|----------------------|----------|
| 1 | **1inch** | 1 + 8453 | **invalid-API-key (revoked)** | Adapter throws without key (`oneinch.ts:10`). Probe with the locally-held key → **HTTP 403 “Your API key has been revoked”** on BOTH chains; keyless → 401. `ONEINCH_API_KEY` present in prod (created ~44 d ago) yet 1inch appears in **no** monitor snapshot Apr 18 → Jul 2 → the prod key never worked either (revoked or same key). | config/env |
| 2 | **0x** | 1 + 8453 | **missing-or-invalid-API-key (upstream 401)** | Probe with the locally-held key → **HTTP 401 Unauthorized** on `/swap/permit2/quote` (1), `/swap/allowance-holder/quote` (8453) and even plain `/price`. Endpoint alive (401, not 404). `ZEROX_API_KEY` re-created in prod ~31 d ago (≈Jun 2) yet 0x is in **no** snapshot Apr 18 → Jul 2 → the rotation never restored service. | config/env |
| 3 | **Odos** | 1 | **invalid/expired-API-key → anonymous 429 rate-limit** | Full regression chain in §2. Keyless V3 probe → **HTTP 429 “Rate limit exceeded. Register for an API key.”** Live prod samples: **0/4** mainnet responses today. | config/env |
| 4 | **Odos** | 8453 | same cause, **intermittent trickle** | **2/4** live Base samples answered — and **won both** (best price). Signature of keyless/downgraded requests occasionally surviving the shared anonymous limiter (Vercel egress IPs), not of a working key. | config/env |
| 5 | **SushiSwap** | 1 + 8453 | **code/request-shape bug (v7 API drift — the OpenOcean class)** | v7 now **requires `sender`**; the adapter never sends it (`sushiswap.ts:8-14`) → deterministic **HTTP 422** `"Invalid input: expected string, received undefined", parameter: "sender"` on BOTH chains. Re-probe **with** `sender` → **HTTP 200** + full quote. Secondary finding §4. | code (+ on-chain for mainnet execution) |
| 6 | **Bebop** | 1 + 8453 | **missing-API-key (deliberate adapter self-suppression)** | `BEBOP_API_KEY` **and** `BEBOP_SOURCE` are **absent from the prod env** (names inventory). Adapter returns `null` without a key by design (`bebop.ts:74-77`, 9H/9S: demo settlement not executable). Upstream is healthy: keyless JAM v2 → **HTTP 200 Success** with `tx` + settlement/approvalTarget **exactly matching** the repo whitelist constants (`0xbeb0b062…4ea6` / `0xC5a3…579a`). Bebop quoted (and won 10.3%) in the May→Jun 3 window → the key existed then and was removed/expired ~Jun 3-4. | config/env |

**Silence chronology (monitor snapshots):** 1inch, 0x and Sushi appear in **no** per-source table from Apr 18
(all-time) through Jul 2 — they have produced no prod quotes for the whole monitored period, not a recent
regression. Bebop was active May → Jun 3 (10.3% win Jun 3) then vanished. Odos is the only true April→June
regression (§2).

## §2 Odos regression — root cause

**Cause (specific): the `ODOS_API_KEY` installed 2026-04-24 stopped being honoured ~Jun 3-4 (≈40 days after
issue — trial/plan expiry pattern), degrading Odos to the anonymous rate-limit tier, which from Vercel’s
shared egress IPs yields only an intermittent trickle.**

Timeline (each point evidenced):

1. **≤ Apr 18** — Odos healthy keyless: 614 quotes / 16.9% wins (daily `health-2026-04-18`). The adapter was
   already calling `/sor/quote/v3` **without auth** (pre-`4465549` code) — V3 was open then.
2. **Apr 24** — Odos retires unauthenticated access; commit `4465549` adds `odosHeaders()` Bearer auth, and
   `ODOS_API_KEY` is created in the prod env the **same day** (age 70 d at `vercel env ls`, 2026-07-03).
3. **Apr 24 → Jun 3** — keyed service works: May 30 snapshot still shows Odos 391 quotes / 8.7% wins.
4. **Jun 3-4** — collapse: Jun 3 daily lists odos 33.8% win; Jun 4 “odos 0% win (17 quotes)”; from Jun 14-15
   onward only `odos 0% (n=2)` residues. **No code change explains it** — the last `odos.ts` change was
   May 29 (`5a909b4`, URL-resolver refactor, host unchanged) and May 30 still quoted fine.
5. **Jul 3 (this run)** — keyless probe of `/sor/quote/v3` → **429 “Register for an API key for higher
   limits”** (mainnet + Base + legacy `/v2` alike); prod answers 0/4 mainnet, 2/4 Base samples. A *valid*
   key would answer ~100%; a *dead* key falls back to exactly this anonymous-tier trickle.

**Ranked hypotheses + confirmation** (key value not testable here without materializing the secret):
- **H1 (most likely): key expired/downgraded upstream ~Jun 3** (40-day trial). Confirm: Odos dashboard plan
  status, or one `curl -H "Authorization: Bearer $ODOS_API_KEY" https://api.odos.xyz/sor/quote/v3 …` by the
  owner — 200 refutes, 401/429 confirms.
- **H2: plan quota now exhausted early each window** (free tier + our ~1k quotes/day) — same confirm path.
- **H3 (least likely): env-value formatting defect** (whitespace/quotes) — would have failed Apr 24→Jun 3
  too, which contradicts point 3. Confirm only if H1/H2 refute.

## §3 Mainnet FeeCollector ↔ Augustus whitelist — REFUTED, with numbers

On-chain **view** calls (2026-07-03, `whitelistedRouters(address)`, selector `0x0f874a13`, RPC publicnode;
first pass via cloudflare-eth returned spurious reverts — cross-checked and discarded):

**Mainnet FeeCollector V2 `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459`:**

| Router | Whitelisted |
|--------|-------------|
| 1inch V6 `0x1111…2A65` / V5 `0x1111…0582` | ✅ / ✅ |
| **Augustus V5 `0xDEF1…ee57` / V6 `0x6A00…1068` / V6.2 `0x216b…fcae`** | ✅ / ✅ / ✅ |
| Odos `0xCf55…2559` · Kyber `0x6131…37b5` · Sushi RouteProcessor4 `0x46B3…202e` | ✅ · ✅ · ✅ |
| UniV3 SwapRouter02 `0x68b3…c45` · Curve NG `0x16C6…5353` · OpenOcean `0x6352…4e64` · Balancer Vault `0xBA12…F2C8` | ✅ ✅ ✅ ✅ |
| 0x Exchange Proxy `0xDef1…5EfF` | ❌ — **irrelevant**: 0x is FEE_INCOMPATIBLE (native `swapFeeBps` partner fee, never FeeCollector-routed) |
| Sushi **RedSnwapper** `0xAC4c…0b75` | ❌ — prospective only, see §4 |

Base FeeCollector `0xeFC3…f130`: **10/10 frontend-emittable routers ✅** (incl. RedSnwapper).

**The number: 0%.** Of the live winning routes sampled this run (9 samples × both chains: winners velora ×4,
kyberswap ×2, uniswapv3 ×1, odos ×2) **zero** target a router the deployed FeeCollector does not whitelist —
every FeeCollector-routed source’s router, including all three Augustus versions, is whitelisted on both
chains. The 9O-era “Augustus not whitelisted on mainnet” gap has since been **closed on-chain by the owner**;
records citing it are stale. Mainnet execution is therefore **not** whitelist-thinned — the thinning is
entirely the silent-source problem above, and the live mainnet competition today is exactly
**velora + kyberswap + cowswap + uniswapv3** (4/12 sources, consistent across all 4 mainnet samples).

## §4 Secondary finding — Sushi v7 now settles via RedSnwapper on BOTH chains

With the `sender` fix, Sushi v7 returns `tx.to = 0xAC4c6e212A361c968F1725b4d055b47E63F80b75` (RedSnwapper)
on **mainnet too** — no longer RouteProcessor4. Consequences:

- The one-param **code fix restores Sushi quotes on both chains immediately** (display/competition breadth).
- **Execution** after the fix: **Base works today** (RedSnwapper already whitelisted in `routers.ts` 8453 +
  Base FeeCollector ✅). **Mainnet stays quote-only** until (a) `routers.ts`/`ROUTER_WHITELIST` mainnet entry
  is updated (code) **and** (b) RedSnwapper is whitelisted on the mainnet FeeCollector — an **on-chain,
  contract-gated change** (rules #2/#3; AUDIT-TOTAL check: 0C/0H open, W1-L-01 moot, W2-M-01 non-blocking —
  no finding blocks it, but it requires the owner tx + Auditor re-pass). SC-04 fail-closes in the interim
  (money invariant safe — quote-only, W7-L-02 class).

**Lost-best-execution datapoint:** during this run Bebop’s keyless demo quote for WETH→USDC (1 ETH, mainnet)
was **1,720.38 USDC vs 1,714.22 best displayed in prod (+0.36%)**, and Odos **won 2/2** Base samples in which
it responded. The silent five are suppressing real price competition on every quote.

## §5 RICE-ranked remediation

**R**each = fraction of daily quote flow the source would re-enter (both chains ≈ full flow for aggregators);
**I**mpact = price-competition gain (0.25 low / 0.5 med / 1 high, anchored on §4 datapoints + historical wins);
**C**onfidence in the diagnosis; **E**ffort in person-days.

### A — config/env (cheapest, owner-only)
| Rank | Fix | R | I | C | E | RICE | Owner |
|------|-----|---|---|---|---|------|-------|
| 1 | **Renew/upgrade `ODOS_API_KEY`** (Odos dashboard; then one prod sample to verify) | 10 | 1.0 | 0.8 | 0.25 | **32** | TeraHash (env) |
| 2 | **Restore `BEBOP_API_KEY` + `BEBOP_SOURCE`** (Bebop partner key; wiring already correct + whitelists match) | 10 | 1.0 | 0.7 | 0.5 | **14** | TeraHash (env/partner) |
| 3 | **Re-issue `ONEINCH_API_KEY`** (portal — current key lineage revoked) | 10 | 0.5 | 0.8 | 0.5 | **8** | TeraHash (env) |
| 4 | **Fix `ZEROX_API_KEY`** (0x dashboard — 401 on all endpoints incl. `/price`) | 10 | 0.5 | 0.7 | 0.5 | **7** | TeraHash (env) |

### B — code (Code Agent prompt)
| Rank | Fix | R | I | C | E | RICE | Owner |
|------|-----|---|---|---|---|------|-------|
| 5 | **Sushi v7 `sender` param** in `fetchQuote` + `fetchSwapData` (+ regression test asserting no-422); quotes restore on both chains, execution on Base | 10 | 0.5 | 1.0 | 0.5 | **10** | Code Agent |
| 6 | Post-key-renewal observability: alert when a keyed source produces 0 quotes for N hours (prevents a silent repeat of every case above) | 10 | 0.25 | 0.9 | 1 | 2.3 | Code Agent |

### C — on-chain whitelist (contract-gated — NOT done here, flag for the proper gate)
| Rank | Fix | Notes |
|------|-----|-------|
| 7 | **Whitelist Sushi RedSnwapper `0xAC4c…0b75` on mainnet FeeCollector** (+ OrderExecutor if conditional orders should route Sushi), then update `routers.ts` mainnet entry | Owner tx + Auditor re-pass per rules #2/#3. Only worth it after fix 5 proves Sushi wins quotes. AUDIT-TOTAL: no blocking finding. |

*(Deliberately NOT proposed: any change to SC-04 selectors, recipient decoders, or the trusted set — out of
scope and unnecessary; and no source re-enable beyond restoring what `DISABLED_SOURCES = {}` already intends.)*

## FEEDBACK — top-3 RICE fixes

1. **RICE 32 — renew `ODOS_API_KEY`** · owner: TeraHash · type: **env**. Proven winner when it answers
   (2/2 Base samples today; 17% all-time April); single dashboard action + env update.
2. **RICE 14 — restore `BEBOP_API_KEY`/`BEBOP_SOURCE`** · owner: TeraHash · type: **env/partner**. Beats the
   current best price by +0.36% in today’s probe; adapter + whitelists already correct.
3. **RICE 10 — Sushi v7 `sender` fix** · owner: Code Agent · type: **code**. Deterministic 422→200 with one
   query param; restores a 12th…10th source to the quote competition on both chains (execution Base-first;
   mainnet execution separately contract-gated — item C7).

## Boundaries & verification appendix

- **Read-only honoured:** no file in `src/`/`contracts/` touched; no env var created/changed/deleted; on-chain
  interactions were `eth_call`/`eth_getCode` view reads only. `vercel env pull` was attempted for key-validity
  probing, **denied by sandbox policy, and not worked around** — validity conclusions rely on behavioural
  evidence; where insufficient, the finding says **owner-confirm** explicitly (§2).
- **Probes executed (status + ≤220-char body captured, keys only ever inside request headers):** 1inch
  v6.0 quote ×3 (1/8453/keyless) · 0x v2 permit2/allowance-holder/price ×3 · Odos v3 ×2 + v2 ×1 (keyless) ·
  Sushi v7 ×4 (both chains, with/without `sender`) · Bebop JAM v2 ×3 (both chains) · prod `/api/quote` ×9
  (both chains, 3 pairs × sizes) · prod `/api/analytics` ×2 · FeeCollector/OrderExecutor view calls ×26
  across 3 RPCs.
- **Env evidence is names-only** (`vercel env ls production`): presence + age; no values displayed.
- **Monitor history:** `Audits/Daily/health-2026-{04-18,05-30,06-02..07-02}.md` (per-source tables/lines).
  Snapshot counters appear window/reset-affected across months (Apr “all-time” 614 > May 391) — used for
  presence/absence and relative timing only, not absolute-count claims.
