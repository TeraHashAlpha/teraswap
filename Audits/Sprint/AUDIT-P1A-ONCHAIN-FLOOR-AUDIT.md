# AUDIT — P1a on-chain floor: Phase-0 keeper mitigation + ADR-013 (PR #279)

**Branch:** `sprint/order-onchain-floor` (**UNMERGED**, fund-flow — this sign-off gates it).
**Audited SHA:** **`b764b1af195035483c61c0dc5f418e1dd00bb1c2`** (1 commit, SSH-signed).
**Prompt:** `docs/Prompts/AUDIT-P1A-ONCHAIN-FLOOR.md`. **Auditor:** independent (Opus 4.8), read-only.
**Ground:** `Audits/Reviews/THREAT-MODEL-2026-07-07.md` (P1a HIGH / P1b/P1c MED), keeper `order-floor.js`
+ `submission-policy.js` + `executor.js`, #18 Chainlink / #248 DefiLlama, `TeraSwapOrderExecutor.sol`
:505-509/:419-423/:528. **Diff:** 9 files, +922/−4 (2 new pure modules + 28 tests + executor wiring + ADR-013).

## Verdict
- **PART A (Phase 0, fund-flow): APPROVED — 0C / 0H. #279 may merge.** The oracle-bounded floor + fail-closed
  submission are sound and **cannot worsen safety** (a rejected fill is a no-op; on-chain gates untouched). The
  fail-open-on-oracle-outage is a **bounded MEDIUM (P1A-M-01)** → remediation prompt, **does not block merge**.
- **PART B (ADR-013 design): APPROVED-TO-IMPLEMENT.** No blocking design flaw; four design notes (N1–N4) to
  resolve during the separately-Auditor-gated v3 implementation sprint.

## PART A — checks table
| # | Check | Result |
|---|-------|--------|
| A1 | DCA fill below `reference × (1 − 300bps)` → REJECTED | ✅ `order-floor.js decideFloor`: `floorOut = ref × (10_000 − bps)/10_000`; `ok = built >= floorOut`; `built < floor ⇒ ok:false`. Wired at `executor.js:1203-1211` → `!ok` → "refusing to fill, retry next cycle". `DCA_ORACLE_FLOOR_BPS=300`, env-clamped `[50, 2000]` (can't disable/loosen absurdly). |
| A1b | Reference = Chainlink ETH-leg first, else DefiLlama | ✅ `fetchReferencePriceUsd:700`: `ETH_PRICED_ADDRESSES` → `readEthUsd` (Chainlink) first, else DefiLlama (5s abort cap); unmapped chain/any error → null. Precision-safe BigInt fair-value math (`computeReferenceExpectedOut`, 8-dp fixed point). |
| A1c | Rejection DELAYS, never forces execution | ✅ `!ok` → log + `alertOps(dca-floor-breach, WARN)` + **skip this cycle** ("DELAY, never drain… NOT a failure — no orderRetries/failed/alert"). Order stays active → retried; **funds stay** (no-op). Unparseable built output → `ok:false` (refuse, fail-safe). |
| A2 | Silent public-mempool fallback removed | ✅ `submission-policy.js` replaces `FLASHBOTS_RPC ? … : walletClient`. **Mainnet/unknown-prod:** relay → `private`; else `ALLOW_PUBLIC_MEMPOOL` → `public` (explicit, warned); else **`ok:false` (REFUSE, fail-closed)** — no silent public submission. Mirrors the plaintext-key guard. |
| A2b | Base = sequencer-private (claim sound) + corrects "Base sandwichable" | ✅ `SEQUENCER_PRIVATE_CHAIN_IDS={8453}` → `sequencer-private`. **Sound:** Base's single sequencer has a **private mempool** (no public pending-tx gossip) → the classic third-party retail sandwich vector is **absent**; no Flashbots-equivalent needed. **Residual** (sequencer-level / cross-domain MEV) is explicitly covered by the oracle floor, not a relay. Correctly rebuts the threat model's overstated "Base sandwichable (no Flashbots)". |
| A3 | Phase 0 can't worsen safety | ✅ Off-chain keeper logic only — **SC-04 / R1 / on-chain `minimumOutput` untouched**; a rejected fill is a no-op (funds stay); **no `ALLOW_PLAINTEXT_KEY` change** (W8 `TESTNET_CHAIN_IDS` guard unchanged; the P5a Vault stub is a *separate* threat-model item, not touched here). |
| A4 | 28 new keeper tests deterministic | ✅ `order-floor.test.mjs` + `submission-policy.test.mjs` re-run in-session: **28/28 pass** (pure modules — reject/flag/fail-closed cases, deterministic). |

### Fail-open adjudication (the fail-mode)
On **reference failure** (no Chainlink AND no DefiLlama for the pair — a transient oracle outage OR a permanently
oracle-less pair) `decideFloor` returns `ok:true, flagged:true` → the fill **proceeds, flagged** (fail-OPEN on the
independent floor, relying on the aggregator's flat 0.5% `KEEPER_SLIPPAGE`). **Ruling: ACCEPT for Phase 0.** Reasoning:
- **Fail-closed would strand DCAs.** A permanently oracle-less pair (no Chainlink + no DefiLlama) would **never** fill →
  the user's DCA is locked forever — a worse outcome than a bounded slippage risk. A transient outage would **halt all
  DCA** on feeded pairs for the outage duration.
- **The residual is bounded + interim.** The fail-open window only matters *in combination with* another failure (a
  keeper compromise / route-builder bug / loose `/api/swap` calldata) — it is a defense-in-depth gap, not a standalone
  fund path. Phase 0 is explicitly the interim; **ADR-013 §1's no-feed *signed absolute-min* path closes it on-chain**
  (the terminal contract never fills a no-floor order). A rejected fill being a no-op means Phase 0 can't *worsen* safety.
- **Refinement worth doing (P1A-M-01, non-blocking):** the code does not distinguish a *transient outage of a
  normally-feeded pair* (where fail-closed/delay is right — delay ≫ drain) from a *genuinely oracle-less pair* (where
  fail-open avoids stranding). Recommend that distinction + a USD-notional cap on fail-open fills.

## PART A — findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| P1A-M-01 | MED | `order-floor.js decideFloor` (no-reference branch) + `executor.js fetchReferencePriceUsd` | REMEDIATION-PROMPT (non-blocking) | Fail-open floor when no reference exists — right for permanently oracle-less pairs, but a transient outage of a *normally-feeded* pair also fails open (unnecessary outage-window exposure). Bounded (only exploitable with a concurrent keeper/route compromise; rejected fills are no-ops; ADR-013 closes it terminally). Refine: fail-closed/delay on a transient outage of a pair that *has* a feed; keep fail-open+flag only for genuinely no-feed pairs; cap the fail-open fill's USD notional. |
| P1A-I-01 | INFO | `order-floor.js` + `submission-policy.js` comments | REPORT | Phase-0 module comments reference **ADR-011** for the terminal fix; the ADR is **ADR-013** (011/012 taken). Align the references. |

## PART B — ADR-013 design assessment (design review; no implementation required)
**Sound and approved-to-implement.** Element-by-element:
- **§1 per-chunk on-chain floor** ✅ — a **user-signed `maxSlippageBps` (uint16) in the EIP-712 typehash** → the bound
  is **un-griefable by the keeper** (loosening it breaks the signature); floor derived from a **Chainlink read at
  execution** (not keeper calldata); **REVERT** (not the 1-wei clamp) when `tokenOutBalance < floor` → **no dust path**;
  balance-delta measurement + delivery to `order.owner` preserved (R1 parity). **No-feed pairs use a signed *absolute*
  min (a real value, not 1)** — the contract never fills a no-floor order (strictly stronger than Phase-0's fail-open).
  **Reverts don't strand a chunk:** a reverted `executeOrder` doesn't advance `dcaExecutions` → the chunk retries.
- **§2 routerDataHash** ✅ — recommends (b): DCA keeps dynamic calldata but the **oracle floor is the binding
  constraint** (absence of a hash ≠ "no bound"); non-DCA (route pinnable at trigger) requires a **real** `routerDataHash`.
  Closes P1c (no fill has neither a hash nor a floor); a hostile DCA route is still bound by the output floor to `owner`.
- **§3 unordered/bitmap nonce (Permit2-style)** ✅ — replaces the sequential `nonces[owner]` counter → each order
  independently executable/invalidatable; mass-cancel retained; DCA keeps per-`orderHash` counters. Closes **P1b** (a
  never-triggering low-nonce order can no longer block a stop-loss). Battle-tested pattern; correct prerequisite to
  re-wiring Limit/SL/TP.
- **§4 submission** ✅ — Phase-0 policy stays; the floor bounds realised sandwich loss to `maxSlippageBps`.
- **Deploy plan** ✅ — v3 (non-upgradeable → new address) + full Foundry coverage → **mandatory Auditor pass (0C/0H)** →
  **48h timelock**, Base first → dual-run v2/v3 migration (frontend domain + keeper `CONTRACT_ADDRESS`/ABI + router
  allowlist; v2 drains existing orders) → runbook → keep the Phase-0 keeper floor until v3 is live everywhere. Respects
  rules #2/#3 (no deploy without an Auditor pass). ADR numbering (013 vs the proposed 011) correctly resolved.

### ADR-013 design notes to resolve DURING the (separately-gated) v3 sprint — NOT blockers to approving the direction
| ID | Note |
|----|------|
| ADR13-N1 | **Feed-staleness stranding-recovery.** A stale/broken Chainlink feed on a feeded pair must fail-safe (revert/delay), but specify the recovery so a *permanently* broken feed doesn't strand a DCA forever — e.g. allow migration to the signed absolute-min path, or a staleness-grace + operator action. (ADR says "fail safe, not fill blind" but doesn't specify recovery.) Reuse the W3 `validateRoundData` (answer>0 / answeredInRound≥roundId / per-feed staleness). |
| ADR13-N2 | **No-feed absolute-min UX.** The signed absolute `minAmountOut` must be **derived from the current oracle/quote at signing** (reuse `deriveMinimumOutput`) so the UI can't reintroduce the "sign minAmountOut=1" footgun. |
| ADR13-N3 | **On-chain clamp on `maxSlippageBps`.** uint16 allows up to 655% — clamp on-chain to a sane max (mirror Phase-0's [50, 2000]) so a UI bug / mis-sign can't produce an absurdly loose signed bound. |
| ADR13-N4 | **Decimals handling** in the on-chain fair-value math must mirror the decimals-safe BigInt approach in `order-floor.js computeReferenceExpectedOut` (Chainlink 8-dp × per-token decimals) — pin it in the Foundry tests. |

## Remediation prompts (Code-Agent-ready)
1. **P1A-M-01 (non-blocking) — tighten the fail-open floor.** In `order-floor.js`/`executor.js`: pass a
   `feedExpectedForPair` signal (does a Chainlink feed OR DefiLlama listing exist for this pair?) into `decideFloor`.
   When a pair is *expected* to have a reference but the fetch failed this cycle → **`ok:false` (delay/retry — treat as
   a transient outage, delay ≫ drain)**; only a genuinely no-feed pair keeps the fail-open+flag path. Add a USD-notional
   cap on any fail-open fill (mirror `UNVERIFIED_SWAP_BLOCK_USD`). Keeper-only; add tests (transient-outage → reject;
   no-feed → flag; cap enforced). Deterministic, pure-fn preserved.
2. **P1A-I-01 (docs) — align the ADR reference** in `order-floor.js` + `submission-policy.js` comments from ADR-011 → ADR-013.
- **ADR13-N1..N4** are folded into the v3 implementation prompt (the deploy sprint), which carries its own mandatory
  Auditor pass — not part of #279.

## Boundaries
Read-only on `origin/sprint/order-onchain-floor`; no edits, no deploy, no contract change. ADR-013 is design-only —
**no contract is deployed on this ADR**; v3 requires its own implementation + Auditor pass + 48h-timelock deploy sprint
(rules #2/#3). **Sign-off: #279 (Phase 0) may merge; ADR-013 approved-to-implement.**
