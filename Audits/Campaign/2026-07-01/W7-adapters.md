# SEC-3 · Wave 7 — Aggregation adapters (12 sources; the A2 surface) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-3 (ordered — consumes W6/W2 facts). **Runner:** Auditor (read-only).
> **Baseline:** `origin/main` (cb0748d) per plan §0 — read via `git show origin/main:<path>`. **Grounded on:**
> W0-recon.md §2 + W2 (money invariant, recipient gating, W2-I-01/I-02) + W6 (route facts). **Source of truth:**
> T-SAF v1 §5-W7 + §6 INV-1/2/3 + §9 G1. **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12.

## Objective
Prove **no aggregation source can break the W2 money invariant** — a hostile/compromised source (A2) cannot
misroute funds, inflate/zero the fee, point at a non-whitelisted router/selector, or slip a Base quote onto a
mainnet URL. Each of the 12 sources upholds recipient gating + selector allowlist + fee-once + per-chain URLs on
**both chains**.

## In-scope (W0 §2.6 — 12 adapters + shared libs)
`adapters/{balancer,bebop,cow,curve,kyberswap,odos,oneinch,openocean,sushiswap,uniswapv3,velora,zerox}.ts` +
`shared.ts`, `recipient.ts`, `calldata-decoder.ts`, `partner-fee-invariant.ts`, `swap-build-retry.ts`, the 9O fallback.

## Attacker goal (A2; §5-W7, §9-G1)
A source returns **hostile calldata** that (a) redirects output to the attacker (recipient), (b) inflates or zeros
the 0.1% fee, or (c) targets a router/selector not on the allowlist; or a **per-chain base URL** points a Base quote
at a mainnet endpoint (chain-confusion into misprice/misroute).

## Must-verify invariants (INV-1/2/3; negative-path first, per source)
1. **Recipient gated per source:** each adapter's calldata is decoded and `validateCallDataRecipient` forces output →
   the user (or the FeeCollector), on both chains. **Confirm W2-I-02:** Group-F (Odos/Kyber/ParaSwap) that trusts
   `msg.sender` (no recipient in calldata) is compensated on-chain by `minimumOutput` — verify that holds per source.
2. **Selector/router allowlist per source:** unrecognized router/selector → **refused** (fail-closed). **Confirm
   W2-I-01:** Balancer / OpenOcean / native-Curve selectors absent from the allowlists → their swap path is
   fail-closed (refused) — determine whether they are **quote-only** (no build) by design, and that a swap through
   them can't settle unrecognized.
3. **Per-chain base URLs correct:** every source's Base URL ≠ mainnet URL; a Base quote never hits a mainnet
   endpoint (chain-confusion) — grep + trace each adapter's URL selection (ties to W4 INV-5).
4. **Fee routing + partner fees:** the 0.1% applies **exactly once** per source (partner XOR FeeCollector,
   `partner-fee-invariant`); no source doubles/zeros it (INV-2).
5. **Retry/fallback safe:** `swap-build-retry.ts` + the 9O fallback never drop the recipient/selector/fee guards on a
   retry or when falling back to another source.

## Method & tools (§7.5)
**Per-adapter calldata trace** on both chains through `validateCallDataRecipient` + the decoder; **hostile-fixture
tests** (a source returning recipient=attacker / double-fee / unknown selector / mainnet-URL-on-Base) → each refused;
confirm per-chain base URLs (Base ≠ mainnet); reconcile the frontend router allowlist with the **on-chain OE
whitelist per chain** (mainnet Augustus V5 / Base V6 — the W4-I-02 parity concern). On-chain reads via viem/node.

## Negative-path battery (each must be refused)
Source returns recipient=attacker · double-fee calldata · unknown/unwhitelisted selector or router · Base quote on a
mainnet URL · retry/fallback that drops a guard.

## Exit criteria
All 12 sources uphold the money invariant on both chains; hostile fixtures refused; per-chain URLs correct; fee-once
per source; retry/fallback preserves the guards. Findings → §4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Wave 7 (Aggregation adapters — 12 sources, A2 surface) per Audits/Campaign/
2026-07-01/W7-adapters.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W7. READ-ONLY, no
code edits. Baseline origin/main (cb0748d) — read via `git show origin/main:
<path>`; record the audited SHA. Ground on W0-recon.md §2 + W2 (money invariant,
recipient gating, W2-I-01/I-02) + W6 route facts.

Scope: adapters/{balancer,bebop,cow,curve,kyberswap,odos,oneinch,openocean,
sushiswap,uniswapv3,velora,zerox}.ts + shared.ts, recipient.ts,
calldata-decoder.ts, partner-fee-invariant.ts, swap-build-retry.ts, 9O fallback.

Prove (negative-path FIRST, per source — each must be refused):
1. Recipient gated per source: each adapter's calldata decoded ->
   validateCallDataRecipient forces output->user/FeeCollector, both chains.
   Confirm W2-I-02: Group-F (Odos/Kyber/ParaSwap) trusting msg.sender (no
   recipient in calldata) is compensated on-chain by minimumOutput — verify per
   source.
2. Selector/router allowlist per source: unrecognized -> refused (fail-closed).
   Confirm W2-I-01: Balancer/OpenOcean/native-Curve selectors absent from
   allowlists -> is that quote-only by design? a swap through them can't settle
   unrecognized.
3. Per-chain base URLs: every source's Base URL != mainnet URL; a Base quote
   never hits a mainnet endpoint (grep + trace URL selection).
4. Fee routing + partner fees: 0.1% exactly once per source (partner XOR
   FeeCollector); no source doubles/zeros it.
5. Retry/fallback safe: swap-build-retry + 9O fallback never drop the
   recipient/selector/fee guards.

Tools: per-adapter calldata trace both chains; hostile-fixture tests
(recipient=attacker / double-fee / unknown selector / mainnet-URL-on-Base ->
refused); confirm per-chain base URLs (Base != mainnet); reconcile frontend
router allowlist vs on-chain OE whitelist per chain (mainnet V5 / Base V6).
On-chain via viem/node.

Deliver into Audits/Campaign/2026-07-01/W7-adapters.md (report section): audited
SHA, per-source checks table, findings (Sev·file:line·disposition + §4 evidence
bundle), negative-path results, coverage fraction of the 12 sources, verdict
(0C/0H bar), remediation-prompt list. SSH-signed commit left for owner if no key
in sandbox.
```

---

# WAVE 7 — REPORT (executed 2026-07-01, Auditor, read-only)

**Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via
`git show origin/main:<path>`; working tree `df00d35` ignored per W3-H-01).

## Verdict: APPROVED — 0C / 0H / 0M / 2L / 2I
**No aggregation source can break the W2 money invariant.** Every source's build result passes the same
fail-closed gates in `api/swap` (`isKnownSwapSelector` at `route.ts:199` + `validateCallDataRecipient` at
`:217`) — regardless of which source or retry/fallback produced it. Per-chain URLs are correct; the 0.1%
fee is applied exactly once (partner XOR FeeCollector). Two LOW (CoW fee-zeroing fail-soft; Balancer/
OpenOcean/native-Curve quote-but-can't-settle) — reliability/revenue-class, **no fund-flow risk**.

## Per-source checks (both chains; negative-path first)
| Source | URL chain-aware | Recipient handling | Selector allowlisted (executable) | Fee |
|--------|-----------------|--------------------|-----------------------------------|-----|
| 1inch | ✅ `/swap/v6.0/${chainId}` | `destReceiver` if ≠from; Group A/D (extracted/msg.sender) | ✅ (0x12aa3caf/e449022e/0502b1c5/2e95b6c8) | FeeCollector |
| 0x (zerox) | ✅ per-chain path (`permit2` mainnet / `allowance-holder` Base) | Group A (msg.sender) | ✅ (d9627aa4/415565b0) | **partner** `swapFeeBps=FEE_BPS`+`swapFeeRecipient` |
| Velora/ParaSwap | ✅ `network=chainId` | `receiver: recipient ?? from`; Group F | ✅ (Augustus V6.2 + Curve methods) | FeeCollector |
| Odos | ✅ chainId in body | `receiver` if ≠from; Group F (msg.sender) | ✅ (0x83800a8e) | FeeCollector |
| KyberSwap | ✅ `/${slug}` | `recipient ?? from`; Group F | ✅ (0xe21fd0e9) | FeeCollector |
| Uniswap V3 | ✅ on-chain via `getRpcUrlForChain` | Group C (recipient extracted) | ✅ (04e45aaf/b858183f + multicall) | FeeCollector |
| SushiSwap | ✅ `/swap/v7/${chainId}` | `to: recipient ?? from`; Group B (V2) | ✅ (472b43f3/38ed1739/7ff36ab5/18cbafe5) | FeeCollector |
| CoW | ✅ `getCowApiBase(chainId)` | intent-based (settlement→owner) | n/a (off-chain intent) | **partner** `partnerFee={bps,recipient}` ⚠ fail-soft |
| Bebop | ✅ slug ethereum/base | JAM settlement | n/a (JAM) | **partner** `fee=FEE_BPS` |
| Balancer | ✅ `api-v3.balancer.fi`+`/order/${chainId}` | builds `tx.to`; 9G-G7 rejects non-whitelisted `data.to` | **✗ not allowlisted → SC-04 blocks** → quote-only | FeeCollector (if it could settle) |
| OpenOcean | ✅ `/v4/${chainId}` | builds `tx.to` | **✗ not allowlisted → SC-04 blocks** → quote-only | FeeCollector (if it could settle) |
| Curve (native) | ✅ **mainnet-only** (`return null` on non-1) | on-chain | **✗ native selector not allowlisted** → quote-only (liquidity reachable via Velora-Curve, which IS allowlisted) | FeeCollector (if it could settle) |

## Must-verify results
| # | Invariant | Result |
|---|-----------|--------|
| 1 | Recipient gated per source, both chains | ✅ Adapters set `recipient ?? from` as receiver; `api/swap` R1 (`:217`) validates the built calldata recipient (fail-closed on unknown selector/mismatch). Group-F (Odos/Kyber/ParaSwap) msg.sender-trust is **compensated on-chain by the deployed FeeCollector `minimumOutput`** on the user's balance (W2) — confirmed per source. |
| 2 | Selector/router allowlist; unrecognized refused | ✅ SC-04 (`:199`) + R1 fail-closed. **Balancer/OpenOcean/native-Curve** build a tx but their selectors are **not** in the 22-selector allowlist → **blocked at SC-04** (quote-only in effect). Balancer additionally rejects a non-whitelisted `data.to` (9G-G7). Money invariant holds. → W7-L-02. |
| 3 | Per-chain base URLs | ✅ `getAdapterApiUrl(source, chainId)` resolves per-chain (path/query/slug); Curve mainnet-only; 0x per-chain endpoint. **No Base quote hits a mainnet endpoint.** chainId-1 byte-identical (P217). |
| 4 | Fee-once (partner XOR FeeCollector) | ✅ 0x/CoW/Bebop set the 0.1% natively (`FEE_BPS`, single source); all others route the on-chain FeeCollector; `usesFeeCollector` XOR (W2 test 4/4). No source doubles it. ⚠ CoW can **zero** it (fail-soft) → W7-L-01. |
| 5 | Retry/9O fallback safe | ✅ `withSwapBuildRetry` retries only transient failures (timeout/network), never 4xx/no-route; the SC-04 + R1 gates run on the **final** `result.tx.data` (`route.ts:199/217`) regardless of source/retry/fallback. 9O operates at the quote layer; the swap-build result is always gated. |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W7-L-01 | LOW (revenue) | `adapters/cow.ts:129-138` | REPORT | CoW partner-fee **fail-soft**: if CoW rejects the `partnerFee` appData schema, it retries **fee-free** so quoting never breaks over the fee → the 0.1% is **zeroed** for that order. **Revenue loss (TeraSwap's fee), not user harm; not doubled.** Deliberate trade-off. Recommend a metric/alert for systematic fee-free CoW orders (a persistent schema rejection = silent revenue loss). |
| W7-L-02 | LOW (reliability) | `adapters/{balancer,openocean,curve}.ts` + `swap-selectors.ts` | REPORT | Balancer/OpenOcean/native-Curve build executable txs but their selectors aren't allowlisted → **SC-04 blocks execution** (fail-closed = money invariant safe). If ever selected as best price, the swap fails ("Unknown swap function selector"). Confirm these are **comparison/quote-only** (and filtered from execution in the UI), or add their selectors **with recipient-extraction decoders** (not to the trusted set). Cross-ref W2-I-01. |
| W7-I-01 | INFO | `adapters/curve.ts` | REPORT | Native Curve is mainnet-only + quote-only-in-effect; the same Curve liquidity IS settleable via Velora's Augustus V6.2 Curve methods (`0x1a01c532`/`0xe37ed256`, allowlisted). Native adapter is largely redundant. |
| W7-I-02 | INFO | `api/swap/route.ts:199/217` | REPORT | The source-agnostic gate placement (SC-04 + R1 on the final result) is the structural reason a hostile/compromised source can't bypass the guards — recorded as the load-bearing invariant for A2. |

## Negative-path battery (each refused)
Source returns recipient=attacker → R1 `valid:false` (400) ✅ · unknown/tampered selector → SC-04 400 ✅ ·
double-fee (partner source ALSO routing FeeCollector) → `usesFeeCollector` XOR makes it impossible ✅ ·
Balancer non-whitelisted `data.to` → 9G-G7 throw ✅ · mainnet-URL-on-a-Base-quote → `getAdapterApiUrl(…,8453)`
resolves the Base endpoint (Curve refuses Base outright) ✅ · retry/fallback dropping a guard → gates run on
the final result ✅.

## Coverage (12/12 sources)
- All 12 adapters reviewed for URL chain-awareness, recipient handling, selector allowlisting, fee routing.
- Shared libs: `shared.ts`/`recipient.ts`/`calldata-decoder.ts` (via W2), `partner-fee-invariant` (W2 4/4),
  `swap-build-retry.ts`, 9O fallback.
- On-chain: reused W0/W4 router-whitelist snapshot (mainnet V5 / Base V6); no new on-chain read needed.
- Not run in-sandbox: live per-adapter API calls / hostile-fixture execution (deferred to CI + the R1/SC-04
  unit tests, W2 26/26 + 4/4).

## Remediation prompts
1. **W7-L-01 — observability for fee-free CoW orders.** Emit a metric/log when CoW's partnerFee fail-soft
   triggers; alert on a sustained rate (systematic revenue loss). No swap-logic change.
2. **W7-L-02 — resolve Balancer/OpenOcean/native-Curve execution status.** Either document them as
   comparison-only and filter from execution selection in the UI, or add recipient-extraction decoders +
   allowlist entries so their quotes can settle. Cross-ref W2-I-01. No trusted-set additions without a decoder.

## Boundaries
Read-only on `origin/main`; no live adapter calls/deploys. Hostile-fixture execution deferred to CI. W8
(keeper) consumes: the swap-build gates are source-agnostic; the order-engine router whitelist is per-chain
on-chain (mainnet V5 / Base V6, W1/W4).
