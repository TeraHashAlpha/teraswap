# CHORE-DOCS-REFRESH — modernize user-facing product docs (add DCA, deepen technical depth)

## Context
The site's docs/feature pages (Privacy, Fee Structure, Limit Orders, Stop Loss / Take Profit, Split Routing)
are stale — they predate the order-engine + multi-chain work and have **no DCA page**, while DCA is now the
flagship conditional-order type on Base. These are **technical product docs rendered in-app** (NOT marketing —
they stay in the main repo, never the marketing repo). Advanced readers should come away understanding the
system is solidly engineered.

## Objective
Add a DCA page, reconcile the conditional-order pages with current per-chain reality, and raise the technical
depth across the docs for advanced users — every claim verified against the code, nothing fabricated or
overstated.

## Requirements
1. **Add a DCA (Dollar-Cost Averaging) page.** Accurate + technical:
   - What: recurring autonomous buys on a fixed schedule, best price at each execution.
   - Flow: one **exact-amount** ERC-20 approval (WETH) to the OrderExecutor, then a **single EIP-712 order
     signature** — no per-execution signing. Input must be an ERC-20 (WETH), never native ETH.
   - Execution: a self-hosted keeper executes each chunk on schedule, pays the gas, routes each chunk across
     the 11+ liquidity sources, MEV-protected.
   - On-chain integrity: **cumulative chunk accounting** (`cumulativeTarget = amountIn·(execCount+1)/dcaTotal`)
     → no chunk skipped/duplicated/double-spent; on-chain `canExecute` gating (balance + allowance + schedule +
     expiry); pure DCA needs no oracle (`priceFeed=0` ⇒ always-true condition).
   - Availability: **Base (L2)** — explain *why* L2-only (mainnet gas unviable for small recurring orders).
   - Safety: a manual freeze circuit-breaker — **delay, never loss** (no cancellation, no fund movement).
2. **Reconcile Limit Orders + Stop Loss / Take Profit** with current reality: frame them as conditional orders
   on the same EIP-712 engine + keeper, gated by **Chainlink oracle** price conditions (`targetPrice` +
   above/below). State **per-chain availability accurately** — verify in code which order types are actually
   exposed on Base vs mainnet today; do NOT claim a feature live where it's gated/removed.
3. **Deepen technical depth** (truthfully) across the docs:
   - Meta-aggregation: 11+ sources, Chainlink validation on every swap, MEV protection via CoW, non-custodial.
   - Order engine: EIP-712 signed intents, on-chain executor validation, keeper signing via **AWS KMS (key
     never leaves the HSM)**, **48h timelock** on executor-whitelist changes, **fail-closed chain-aware** gating.
   - Token safety: curated catalog where every token is on-chain-verified (symbol, decimals, transferability)
     by an automated guard.
   - Update Fee Structure (0.1% via the FeeCollector contract; exact-amount approvals — "no infinite
     approvals"), Split Routing (best-execution / meta-aggregation), Privacy (no-KYC, permissionless,
     non-custodial, client-side) **only where stale**.
4. **Verify every technical claim against the actual code/contracts before writing it — do NOT fabricate.** If
   unsure a feature is live or works as described, check the source or omit it. No invented numbers, addresses,
   or guarantees.

## Do NOT
- No secrets or internal infrastructure in docs (KMS key IDs, EC2 IPs, env/secret names, RPC keys) — only
  public contract addresses + architecture concepts.
- Don't overstate security/audit posture (no "audited"/"unhackable"; the site shows a "beta, unaudited"
  banner — keep claims truthful).
- No marketing strategy/copy (that lives in the separate `dex-aggregator 2.marketing/` repo) — technical docs
  only.
- Don't publish "DCA is live" ahead of the go-live — gate the DCA page behind the launch flag or note it ships
  with launch.
- Keep no-KYC / permissionless as a **fixed property**, not a roadmap item.

## Files affected (verify on main)
- The docs/content pages behind the site nav (Privacy, Fee Structure, Limit Orders, Stop Loss / Take Profit,
  Split Routing) — likely MDX/content or a `/docs` route under `src/`.

## Expected output
- Branch `chore/docs-refresh` off latest `origin/main`; SSH-signed commits; CI green.
- New DCA page + updated order-type / fee / routing / privacy docs.
- **FEEDBACK listing any claim it could not verify** against the code (so the Architect confirms before
  publish). No Auditor (docs only), but flag any security-claim doc for owner review.

## Quality criteria
A technically-accurate DCA page exists; Limit/SL·TP reflect real per-chain availability; advanced readers get
genuine architectural depth (EIP-712, keeper/KMS, cumulative accounting, chain-aware fail-closed, oracle
validation, catalog guard) with **zero fabricated or overstated claims**; no secrets/infra leaked.

## Owner notes (Architect)
- Review the FEEDBACK's unverifiable-claims list before merge — confirm the security claims especially.
- Coordinate the DCA page's publish with the Base DCA go-live (don't ship "DCA live" before the unfreeze).
