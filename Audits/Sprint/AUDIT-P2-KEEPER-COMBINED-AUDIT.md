# AUDIT — P2 value gate (#280) + keeper hardening (#282), combined

**Auditor:** independent (Opus 4.8), read-only. **Method:** diffs only (no CI poll); scope = #280 + #282 diffs + cited files.
**Audited SHAs (both UNMERGED — this sign-off gates each merge):**
- **#280** `chore/oracle-value-failclosed` = **`337ed98f5db98133ffe6b2471bee71744ac60812`** (1 commit, signed).
- **#282** `chore/keeper-hardening` = **`87687ce53e6519d281de1b023090955f5269dca6`** (4 commits: `13851ee` P5a / `c7112cf` P1A-M-01 / `990c1bd` P1A-I-01 / `87687ce` docs — all signed).

## Verdicts
- **#280 (P2 value gate): APPROVED — 0C / 0H. May merge.**
- **#282 (keeper hardening): APPROVED — 0C / 0H. May merge.**
Both are off-chain / server-side; on-chain gates (SC-04, R1, on-chain `minimumOutput`) untouched. No blocking finding; two INFO notes.

## PART 1 — #280 (P2, value gate fails CLOSED)
| Check | Result |
|-------|--------|
| >$10k block fails closed; value = max(inputUsd, outputUsd) | ✅ `route.ts` computes `estimatedValueUsd = Math.max(...candidates)` where candidates = DefiLlama(src), DefiLlama(dst), **and** server Chainlink `computeTokenAmountUsd(src/dst)` (mainnet-only, chain-gated) — **both legs, both sources.** Replaces the old INPUT-only `× DefiLlama` estimate. |
| Unpriceable → explicit 422, not $0 (aToken bypass closed) | ✅ `if (!valuePriced)` → `422 { error, priceGuard:true, blocked:true, unpriceable:true }`. The old `$0 ⇒ silently under the >$10k gate` (P2 aToken incident) is gone. Client mirror (`SwapBox` + pure `swap-usd-estimate.ts`): `oracleBlocked = … (\|\| valueUnverifiable)` blocks on `!priced` — never trusts `0`. |
| Block-all-unpriceable RATIFIED (permissionless-sound) | ✅ **Ratified.** Without a USD measure the >$10k ceiling is unenforceable, so the only safe policy is block; the alternative (fail-open) IS the P2 bypass. The block is **narrow** — it fires only for **exotic↔exotic** pairs (both tokens outside DefiLlama AND Chainlink); ANY priceable side yields a real `max(in,out)` estimate + the unchanged threshold. Correct conservative default for a permissionless aggregator. |
| No regression | ✅ Small **priceable** swaps unchanged (`<$10k` still fail-open on the DefiLlama deviation — the `validateSwapPrice`/threshold path is untouched). The 3 Base fixtures now supply a priceable fixture so the unpriceable-422 doesn't pre-empt the chain/sequencer gate they pin — **pricing-orthogonal, assertions sound**. `stablecoins.test` `isUsdStablecoin` use-count moved (SwapBox 3→2, +1 in `swap-usd-estimate.ts`) — relocation only. **No new oracle** (`computeTokenAmountUsd` = existing Chainlink plumbing; DefiLlama existing). |

**#280 INFO:** (i) block-all-unpriceable removes genuinely exotic↔exotic pairs from the app — accepted UX trade-off for closing P2 (revisit later with a per-token allowlist if needed); (ii) the Chainlink value legs are mainnet-only by design (`computeTokenAmountUsd` has no chainId → resolves mainnet feeds; correctly gated to `swapChainId === DEFAULT_CHAIN_ID`), so Base sizes on DefiLlama-only — chain-correct, not a gap.

## PART 2 — #282 (keeper hardening)
| Check | Result |
|-------|--------|
| **P5a — Vault stub THROWS (no silent plaintext)** | ✅ `kms-signer.js:219-224`: `if (vaultAddr && shouldRefuseUnwiredVault(true)) throw`. The old `console.log("Falling back to plaintext key")` silent fallthrough is gone; the final fallthrough also throws (`:235`). No silent `privateKeyToAccount`. |
| **P5a — unwired Vault not a managed signer** | ✅ `signer-guard.js` `VAULT_WIRED=false`; `vaultCountsAsManagedSigner()→false`. `executor.js validateConfig:302` gates the plaintext guard on `!vaultCountsAsManagedSigner(hasVault)`, so **a configured VAULT_ADDR no longer suppresses the plaintext-key FATAL**. `resolveSignerKind` (KMS > wired-Vault > plaintext > none) + FATAL on `none` = startup signer-type resolution. **A plaintext mainnet key CANNOT run silently — fail-closed, no residual bypass.** `ALLOW_PLAINTEXT_KEY` escape hatch + `TESTNET_CHAIN_IDS` guard **unchanged** (W8). |
| **P1A-M-01 — transient vs feedless split + $250 cap** | ✅ `fetchReferencePriceUsd` returns `{price, transient}`: DefiLlama **5xx/429/network ⇒ transient** (oracle up, momentary), **4xx / 200-no-price ⇒ feedless** (authoritatively uncovered); the **ETH leg is always transient** (ETH always has a feed). `combineReferenceStatus` (transient dominates) → `decideFailOpen`: **transient ⇒ DELAY** (never fill unbounded); **feedless ⇒ fill only if `notionalUsd ≤ DCA_FAIL_OPEN_MAX_USD` ($250, clamped [0,100k]), else DELAY**; **unsizable feedless (no priced leg) ⇒ DELAY** (never blind fill). |
| **P1A-M-01 — un-gameable** | ✅ An attacker **cannot force "feedless"** on a covered pair (DefiLlama's "absent" is authoritative; the attacker doesn't control it). Forcing "transient" (DoS the oracle → 5xx) yields **DELAY** — the safe direction (delay ≫ drain). The only fail-open path (feedless, ≤$250) requires the token to be **genuinely** uncovered. $250 cap sane (small notional); `[50,2000]` bps floor band intact. |
| **P1A-I-01 — ADR refs fixed** | ✅ `990c1bd` corrects the Phase-0 comments ADR-011 → ADR-013. |
| Off-chain only; gates untouched | ✅ All keeper (order-floor/signer-guard/submission-policy/executor). On-chain SC-04/R1/`minimumOutput` untouched; a rejected/delayed fill is a no-op; no `ALLOW_PLAINTEXT_KEY` change. |
| Tests | ✅ Keeper `node --test` (order-floor + signer-guard + submission-policy): **46/46 pass** (reject/flag/transient/feedless/cap/fail-closed cases, deterministic pure modules). |

**#282 INFO:** none material — P5a and the P1A-M-01 refinement are both closed as designed.

## Findings by severity
**0 Critical / 0 High / 0 Medium / 0 Low** across both PRs. INFO only (#280-i/ii above). No remediation prompt required — both PRs **close** their tracked items:
- #280 closes **TM-P2** (unpriceable value-gate bypass).
- #282 closes **TM-P5a** (Vault→plaintext silent downgrade) and the **P1A-M-01** fail-open residual from the prior P1a audit (transient→DELAY, feedless→$250-capped, un-gameable), and fixes **P1A-I-01**.

## Boundaries
Read-only on both branch heads; diffs + cited files only; no edits, no CI poll, no deploy. **Sign-off: #280 and #282 may each merge (0C/0H).**
