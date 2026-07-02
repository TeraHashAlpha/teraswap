# T-SAF Campaign 2026-07-01 — MASTER REPORT

> **Framework:** `docs/security/TERASWAP-AUDIT-FRAMEWORK.md` (T-SAF v1). **Auditor:** independent (Opus 4.8), read-only on source.
> **Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via `git show origin/main:<path>`).
> **Waves:** W0 recon → W11 synthesis. **Per-wave reports:** `Audits/Campaign/2026-07-01/W{0..10}-*.md`.

## Campaign verdict: **APPROVED — 0 Critical / 0 High (product)**
Across the **entire attack surface** (3 own contracts, 31+ API routes, 15 gate/oracle libs, the multi-chain
registry, 12 aggregation adapters, the keeper, the wallet/frontend layer, and supply-chain/CI on **Ethereum
mainnet + Base**), **no Critical or High product finding was identified.** The single HIGH raised —
**W3-H-01** — was a *process/grounding* issue (the campaign initially read a branch 261 commits behind
production), resolved by re-baselining every subsequent wave onto `origin/main`. The **on-chain guards are the
proven terminal backstop**: no cross-wave attack chain reaches user funds (§ cross-wave analysis). §2
inventory coverage = **100%**; every §9 attack-tree leaf (G1–G10) exercised-and-refuted or filed.

## 1. Executive summary
- **Fund safety is on-chain-enforced and off-chain-independent.** Every swap/order settles through
  `executeOrder`/the deployed FeeCollector V2, which force delivery to `order.owner` (or the user's own
  balance), enforce **on-chain `minimumOutput`** (verified live on both chains), and require a **chain-correct
  whitelisted router** (mainnet Augustus V5 / Base V6, verified on-chain). A compromised API, source, client,
  keeper, or dependency **cannot misroute funds through the contracts.**
- **Chain-awareness (the #1 historical defect class) is clean on production.** Router/feed/spender/executor/URL
  selection is per-chain; the Base OrderExecutor `0x135B` is wired + on-chain-verified (V6, distinct EIP-712
  domain); mainnet is byte-identical to the W0 baseline.
- **Gates hold and fail safe.** Chainlink round-integrity + per-feed staleness (fail-closed), depeg
  (leg-fail-closed / verdict-fail-open), DefiLlama >$10k (fail-closed) / <$10k (fail-open), and the L2 sequencer
  gate on quote + swap-build + price-read — all chain-aware, none skippable; feed addresses on-chain-verified.
- **Signing-trust is sound.** Every wallet/keeper signature is over a **reviewed frozen payload**; nonce +
  distinct per-chain EIP-712 domains block replay; admin Bearer is constant-time + unlogged; approvals are exact-amount.
- **CI is a real gate.** `test-contracts` blocking, 8 domain guard jobs, keeper-tests (127/127), gitleaks
  (bare-hex EVM-key rule), empty audit-allowlist (0 masked high/critical), signed commits.
- **The campaign loop works:** two W2 findings (W2-L-01, W2-M-01) and the W8 plaintext-key Base gap were
  **remediated on `main`** during the campaign (via `audit/w…` PR #254 + the guard suite).

## 2. Consolidated findings (all waves, deduped) — with current status on `main`
**Counts (net of on-main remediations): 0C / 0H / 2M / 8L / many-I.** (W3-H-01 was process, resolved.)

| Sev | ID | Wave | file:line | Status on `main` | Note |
|-----|-----|------|-----------|------------------|------|
| ~~H~~ | W3-H-01 | W3 | working-tree branch | **RESOLVED** (re-baselined onto `origin/main`) | Process/grounding, not a product vuln. |
| MED | W6-M-01 | W6 | `api/orders` GET, history, analytics/personal | REPORT (open) | Unauth `?wallet=` read exposes **pending-order strategy** by address. Writes are signature-gated. No fund loss. |
| MED | W6-M-02 | W6 | `log-{swap,quote,event,activity}`, `orders` POST | REMEDIATION-PROMPT (open) | Unauth + un-rate-limited inserts → spam/poisoning/cost. Auto-fixable. |
| ~~MED~~ | W2-M-01 | W2 | `…V2_flat.sol` / source-of-truth | **FIXED-on-main** | `DEPLOYED-SOURCES.md` + `deployed-sources-guard` + deprecated flat (PR #254). |
| LOW | W1-L-02 | W1 | on-chain admin `0x9A38` (EOA) | REPORT (open) | Single-EOA admin over both chains; mitigated by timelocks; → Key-Hardening (Safe/HW). |
| LOW | W6-L-01 | W6 | POST routes (ex-swap) | REMEDIATION-PROMPT (open) | Body-size cap only on swap; platform ~4 MB default elsewhere. Auto-fixable. |
| LOW | W7-L-01 | W7 | `adapters/cow.ts:129` | REPORT (open) | CoW partner-fee fail-soft **zeroes** the 0.1% on a schema rejection (revenue, not user harm). Add metric. |
| LOW | W7-L-02 | W7 | balancer/openocean/native-curve | REPORT (open) | Build a tx but selector not allowlisted → SC-04 blocks execution (fail-closed/safe); confirm quote-only. |
| LOW | W9-L-01 | W9 | `secure-storage.ts:184` | REMEDIATION-PROMPT (open) | Plaintext fallback when the wallet key isn't derived (edge). No keys/seeds stored. Auto-fixable. |
| LOW | W10-L-01 | W10 | lockfile (viem×2) | REPORT (open) | viem 2.47.4 (app) + 2.23.2 (`@walletconnect/utils`). Bundle bloat, not a runtime bug. Optional. |
| ~~LOW~~ | W2-L-01 | W2 | `useSwap.ts:458` | **FIXED-on-main** | `deriveMinimumOutput` throws `UnusableQuoteError` (refuse), not minOut=0; `minimum-output-guard`. |
| ~~LOW~~ | W1-L-01 | W1 | `…V2_flat.sol` transferAdmin/selector | **SUPERSEDED** | Those functions don't exist on the deployed contract (W2 correction). |
| INFO | W4-I-01/02, W5-I-01/02, W6-I-01/02, W7-I-01/02, W8-I-01/02, W9-I-01/02, W3-I-01/02, W2-I-01/02, W10-I-01/02 | — | — | REPORT | Docs/ops/design notes; none reach funds. Detailed in each wave report. |
| ~~INFO~~ | W1-I-02 (V2 no minOutput) | W1 | — | **REFUTED on-chain** | Deployed V2 enforces minimumOutput (W2). |
| ~~INFO~~ | W1-I-03 (no Base OE) | W1 | — | **REFUTED on-main** | Base OrderExecutor `0x135B` wired + on-chain-verified (W4). |

**Open backlog:** 2 MED + 6 LOW + INFO. **Zero contract-source remediation pending** (W1-L-01 superseded).

## 3. Cross-wave attack-chain analysis (§10) — NO chain reaches user funds
The flagship test: can **any** off-chain finding compose into fund loss? Each chain terminates at the on-chain
guards (W1/W2): **recipient = order.owner ∧ on-chain `minimumOutput` ∧ chain-correct whitelisted router.**

| # | Composed chain | Terminal backstop | Result |
|---|----------------|-------------------|--------|
| A | Compromised `api/swap` (W6) returns hostile calldata → client builds/signs (W9) | R1 recipient gate (client+server, fail-closed) + on-chain minimumOutput + router whitelist | **Refuted** — output→owner or revert |
| B | Hostile source (W7) returns recipient=attacker + client min-output downgrade (W9) | R1 refuses recipient≠owner; DefiLlama −8% (server); on-chain minimumOutput | **Refuted** — no bad-price/misroute settle |
| C | Attacker reads a victim's pending order strategy (W6-M-01) → attempts front-run | Order executes to the **victim** at their minOut via the keeper (MEV-protected) | **Refuted for funds** — strategy leak only (privacy) |
| D | KMS-hostile keeper (W8) submits executeOrder | Contract forces owner-delivery + minOut + whitelist; forged sig → revert | **Refuted** — can't misroute via contract; `pause()` is the stop |
| E | Poisoned transitive dep / viem dup (W10) alters the build | audit-gate + lockfile-lint + gitleaks + overrides pin; on-chain guards still bind | **Refuted** — build compromise can't bypass on-chain |
| F | Freeze weaponized (W8) / DoS (W6-M-02) | Freeze = delay-not-loss, single admin writer; rate-limit gap = cost/liveness only | **Refuted for funds** — DoS/cost at most |

**"Protection here / missing there" hunt:** the only intentional asymmetry is order **reads public /
writes signature-gated** (W6, documented) — reads leak strategy (W6-M-01) but never reach funds. Min-output is
layered consistently (on-chain OE + deployed FeeCollector + server DefiLlama + client + router amountOutMin). No
gap that reaches funds was found. **The on-chain guards are the single, sufficient terminal backstop.**

## 4. Coverage attestation — §2 = 100%, §9 G1–G10 refuted
**§2 inventory (W0 denominator) → owner wave, all covered:**
2.1 contracts→W1 · fund-flow→W2 · 2.2 gates/oracle→W3 · 2.3 registry/chain-aware→W4 · 2.4 signing→W5 ·
2.5 the 31+ routes→W6 · 2.6 the 12 adapters→W7 · 2.7 keeper→W8 · 2.8 wallet/frontend→W9 · 2.9 supply-chain/CI→W10.
**No orphan surface; no double-owned item. Coverage = 100%.**

**§9 attack-tree leaves — each exercised-and-refuted (or filed):**
G1 steal funds → W1/W2 (recipient=owner, minOut, allowlist, reentrancy, fee-once) ✅ ·
G2 manipulate price/gate → W3 (staleness/deviation/depeg/defillama/sequencer, chain-aware) ✅ ·
G3 MEV → W2/W9 (CoW MEV-protection + server min-output) ✅ ·
G4 forge/replay sig → W5 (nonce, per-chain domain, review-gate, constant-time Bearer) ✅ ·
G5 chain confusion → W4 (per-chain everything, V5/V6, Number coercion) ✅ ·
G6 DoS/liveness → W6/W8 (rate-limit [W6-M-02 gap filed], freeze delay-not-loss, sequencer gate, JSON errors) ✅ ·
G7 privilege escalation → W1/W6/W8 (access control, admin Bearer, single freeze writer) ✅ ·
G8 supply chain → W10 (single-instance, pins, CI gates) ✅ ·
G9 secret exfil/info disclosure → W6/W10 (no NEXT_PUBLIC_ secret, no secret logged, RLS writes gated; W6-M-01 read-leak filed) ✅ ·
G10 data/state integrity → W1/W8 (nonce, atomic lock, confirmed-only recording) ✅.

## 5. RICE-ranked remediation plan
RICE = Reach × Impact × Confidence / Effort. Split by owner.

### 5a. Auto-fixable (safe branch: frontend/config/test/docs + tests; no contract/gate change)
| RICE | ID | Action | Prompt |
|------|-----|--------|--------|
| High | W6-M-02 | Add per-IP `checkRateLimit` to `log-*` + `orders` POST | W6 report §remediation |
| Med | W9-L-01 | Remove secure-storage plaintext fallback for sensitive values (buffer/refuse until key) | W9 report |
| Med | W6-L-01 | Shared body-size guard extracted from swap → orders/log-*/quote/v1 | W6 report |
| Med | W4-I-02 | Single per-chain router-allowlist source + parity test (frontend ⊆ on-chain OE whitelist) | W4 report |
| Low | W7-L-01 | Metric/alert when CoW partner-fee fail-soft fires (systematic revenue loss) | W7 report |
| Low | W4-I-01 | Fix the stale `api.ts:540` "mainnet-pinned" comment | W4 report |
| Low | W5-I-02 | Drop the `?? FEE_COLLECTOR_ADDRESS` mainnet fallback (fail-closed) | W5 report |
| Low | W10-L-01 | (Optional) dedupe viem via override + WC-modal smoke test | W10 report |

### 5b. Needs product / architecture decision
| RICE | ID | Decision |
|------|-----|----------|
| Med | W6-M-01 | Gate pending-order reads (signature/read-token) vs explicitly accept + document (like 13B-L-02). |
| Low | W7-L-02 | Confirm Balancer/OpenOcean/native-Curve are comparison-only (filter from execution) or add recipient-extraction decoders. |

### 5c. Needs human / governance (no code)
| ID | Action |
|-----|--------|
| W1-L-02 | Migrate contract admin `0x9A38` (EOA) → multisig/Safe + HW ([Key Hardening] plan). |
| W8-I-01 | Operational: never set `ALLOW_PLAINTEXT_KEY` in prod; complete keeper→KMS/HW. |

### 5d. Needs contract sprint
**None.** No pending contract-source remediation (W1-L-01 superseded; W2-M-01/L-01 fixed off-chain; on-chain
minimumOutput + Base OE already deployed).

## 6. Campaign process notes
- **W3-H-01 grounding fix** was the highest-leverage catch: without it, W1/W2/W6/W7/W9 frontend/API conclusions
  would have been drawn on code 261 commits behind prod. All branch-dependent findings were re-grounded on `main`.
- **Self-correction:** the RB.1 delta ("W2-L-01 stands on main") was wrong and corrected in W10 — default-skepticism
  applied to the Auditor's own prior pass.
- **In-sandbox tool limits (documented, not gaps):** `cast`/`forge`/`slither` absent → viem/node for on-chain +
  adversarial source read; CI (linux-x64) is the authoritative executable gate for `forge`/`slither`/full vitest.
  On-chain reads and keeper `node --test` (127/127) were re-run in-session.

## 7. Human-only boundaries (documented, not looped)
Live wallet signatures / real-device WalletConnect; on-chain `pause()`/governance/admin txs; deploys; secret
rotation; GitHub branch-protection settings. The Auditor stopped at each and reasoned from the code/on-chain state.

---
### Sign-off
**T-SAF Campaign 2026-07-01: APPROVED — 0C / 0H (product).** On-chain guards are the terminal fund-safety
backstop; no cross-wave chain reaches user funds; §2 coverage 100%; §9 G1–G10 refuted. Open backlog = 2 MED +
6 LOW + INFO (off-chain info-leak / DoS / reliability / hygiene), RICE-planned. Reports are SSH-signed on commit
(owner's batch; no signing key in the audit sandbox).
