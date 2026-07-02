# SEC-2 · Wave 5 — Signing-trust (no signature without a reviewed frozen payload) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-2 (parallel after W0). **Runner:** Auditor (read-only). **Grounded on:**
> `W0-recon.md` §1/§2 (executor domains: mainnet `0xeFC3…`, Base `0x135B…`). **Source of truth:** T-SAF v1 §5-W5 +
> §6 INV-6/7 + §9 G4. **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12.

## Objective
Prove **no wallet or keeper signature is ever produced over a payload different from what was reviewed**, no
signature replays (same- or cross-chain), and admin auth is forgery-proof.

## In-scope (W0-confirmed: signing-trust surface §2.4)
EIP-712 order **create** + **cancel** (`api/orders`, `api/orders/[id]`), **Permit2** approvals, **CoW** order signing
(`adapters/cow.ts`), **swap tx** review, `src/lib/auth.ts` + `api-auth.ts` (Bearer), `calldata-recipient.ts`.

## Attacker goal (§5-W5, §9-G4)
Get a user (or the keeper) to sign a payload ≠ what was reviewed (G4.3); replay a signature same-chain (G4.1) or
cross-chain (G4.2); forge admin Bearer (G4.4).

## Must-verify invariants (INV-6, INV-7; negative-path first)
1. **Review-gate on EVERY signing path:** every `signTypedData`/`sendTransaction`/permit/approval/CoW-order-sign
   shows a TeraSwap review of the **exact frozen payload** before signing (swap / create / cancel / CoW / permit) —
   confirm **none remain un-reviewed**. The signed payload == the reviewed payload (diff them).
2. **Nonce** prevents same-chain replay; **domain pins chainId** (W0: mainnet executor `0xeFC3…` vs Base `0x135B…`)
   → no cross-chain replay (INV-6).
3. **Admin Bearer** = SHA-256 + **`timingSafeEqual`** (constant-time), **server-only**, **never logged** (INV-7).
4. **Recipient binding** in `calldata-recipient.ts` on the signed/settled path (output → owner).

## Method & tools (§7.5)
Enumerate every `signTypedData` / `sendTransaction` / permit / approval / CoW-order-sign call; confirm a review gate
on each; **diff signed-vs-reviewed payload**; constant-time-compare check on `verifyBearerToken`; grep that the
Bearer/secret is never logged. On-chain re-confirm the two executor domain chainIds (viem/node, reuse W0).

## Negative-path battery (each must be refused)
Signature over an unreviewed/modified payload · replayed signature (same chain) · wrong-chain signature · forged/
absent admin Bearer · non-constant-time compare shortcut.

## Exit criteria
No un-reviewed signature path; no replay (nonce + chainId-pinned domain); admin auth constant-time + server-only +
unlogged; recipient binding holds. Findings → §4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Run T-SAF Wave 5 (Signing-trust) per Audits/Campaign/2026-07-01/
W5-signing-trust.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W5. READ-ONLY, no code
edits. Ground on W0-recon.md (executor domains: mainnet 0xeFC3, Base 0x135B).

Scope: EIP-712 order create+cancel (api/orders, api/orders/[id]), Permit2,
CoW order signing (adapters/cow.ts), swap tx review, auth.ts + api-auth.ts
(Bearer), calldata-recipient.ts.

Prove (negative-path FIRST — each must be refused):
1. Review-gate on EVERY signing path: every signTypedData/sendTransaction/
   permit/approval/CoW-order-sign shows a review of the EXACT frozen payload
   before signing (swap/create/cancel/CoW/permit); NONE un-reviewed; signed
   payload == reviewed payload (diff them).
2. Nonce prevents same-chain replay; domain pins chainId (mainnet 0xeFC3 vs
   Base 0x135B) -> no cross-chain replay.
3. Admin Bearer = SHA-256 + timingSafeEqual (constant-time), server-only,
   never logged.
4. Recipient binding (calldata-recipient.ts): output -> owner.

Tools: enumerate every signTypedData/sendTransaction/permit/approval/CoW sign
call; confirm a review gate on each; diff signed-vs-reviewed payload;
constant-time-compare check on verifyBearerToken; grep the Bearer/secret is
never logged; on-chain re-confirm the two executor domain chainIds via
viem/node.

Deliver into Audits/Campaign/2026-07-01/W5-signing-trust.md (report section):
checks-run table, findings (Sev·file:line·disposition + §4 evidence bundle),
negative-path results, coverage fraction of the signing slice, verdict,
remediation-prompt list. SSH-signed commit left for owner if no key in sandbox.
```

---

# WAVE 5 — REPORT (executed 2026-07-01, Auditor, read-only)

**Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via
`git show origin/main:<path>`; working tree `df00d35` ignored, per W3-H-01 re-baseline).

## Verdict: APPROVED — 0C / 0H / 0M / 0L / 2I
Every wallet/keeper signature is produced over a **reviewed, frozen payload**; the *sent == signed*
invariant is explicit; nonce + chain-pinned per-chain EIP-712 domains block same- and cross-chain replay;
admin Bearer is constant-time + server-only + unlogged; approvals are exact-amount; recipient binding is
enforced client-side before the payload is frozen. No un-reviewed signing path found.

## Signing-path inventory (every call site on `main`)
| Path | Call site | Signs/sends | Review-gate |
|------|-----------|-------------|-------------|
| Swap tx | `useSwap.ts:1041` `sendTransaction` (`confirmSwap`) | frozen `pendingSwap {txTo,txData,txValue}` | ✅ built + validated → frozen → user reviews preview → confirm sends unmodified |
| Split-swap leg | `useSplitSwap.ts:475` `sendTransactionAsync` | frozen per-leg tx | ✅ per-leg validate + freeze (10-L-01 minOut noted in W2) |
| CoW order (EIP-712) | `useSwap.ts:899` `signTypedDataAsync` | frozen `p.message` (Order) | ✅ "Sign the EXACT frozen payload (no re-fetch, no rebuild)" + 9U validTo freshness guard |
| Order create (EIP-712) | `useOrderEngine.ts:641` | frozen 15-field `order` | ✅ `signedChainId=chainId` (one const for domain+POST), `getOrderExecutorDomain(chainId)` chain-correct, review cleared if chain changed |
| Order cancel (EIP-712) | `useOrderEngine.ts:846/886` | `{id:rowId, action:'cancel'}` | ✅ per reviewed order, chain-correct domain |
| Mass cancel (on-chain) | `useOrderEngine.ts:870` `writeContractAsync` | `invalidateNonces([p.newNonce])` | ✅ "the FROZEN nonce the user reviewed" |
| Order approval | `useOrderApproval.ts:125` `writeContractAsync` | `approve(spender, amountIn)` | ✅ **EXACT amount, never max-uint**, fail-closed on null/wrong spender |
| Manage/revoke approvals | `ActiveApprovals.tsx:42` | `approve(...)` | ✅ user-initiated in the approvals UI |
| RPC proxy | `api/rpc/route.ts:33-38` | — | ✅ **blocks** eth_sendTransaction / eth_signTypedData* / eth_sign / personal_sign (read-only; never sees keys) |

## Checks-run (negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | Review-gate on EVERY signing path; signed == reviewed | ✅ Swap: `confirmSwap` sends the frozen `pendingSwap` set at `:611` **after** `validateRouterAddress(:361)` + `validateCallDataRecipient(:386, R1)`; no rebuild. CoW/create/cancel sign the explicitly frozen payload. Order create makes *sent == signed* explicit via one `signedChainId`. No un-reviewed path. |
| 2a | Nonce → no same-chain replay | ✅ Order carries `order.nonce` (on-chain `nonces[owner]` single-use / DCA counter); mass-cancel via `invalidateNonces`. |
| 2b | Domain pins chainId + verifyingContract → no cross-chain replay | ✅ `getOrderExecutorDomain(chainId)` per chain (fail-closed). **On-chain re-confirmed this run:** mainnet OE `0xeFC3` domainSeparator `0x335a0ec4…` vs Base OE `0x135B` `0x020a73f6…` — **distinct** ⇒ a mainnet signature is invalid on Base and vice-versa. |
| 3 | Admin Bearer constant-time, server-only, unlogged | ✅ `auth.ts:25` `verifyBearerToken` = SHA-256 both sides → `timingSafeEqual` (no length leak, constant-time). Grep: no `console.*` logs a Bearer/secret value (telegram webhook logs only "Invalid webhook secret" — a message, not the value). |
| 4 | Recipient binding (output → owner) | ✅ Client `validateCallDataRecipient(swapData.tx.data, address, …)` (`useSwap:386`) blocks recipient≠user **before freezing**; server R1 (`api/swap:216`) re-checks; OrderExecutor delivers on-chain to `order.owner` (W1). Triple-gated. |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W5-I-01 | INFO | `useOrderEngine.ts:846/886` (CancelOrder message) | REPORT | The off-chain cancel EIP-712 `{id:rowId, action:'cancel'}` has no nonce/expiry. **Not exploitable:** it is owner-signed, scoped to one Supabase `rowId`, and idempotent (replay re-cancels the same order); the on-chain void still uses the on-chain nonce/`cancelOrder`. No change required; recorded for completeness. |
| W5-I-02 | INFO | `useSwap.ts:341` `feeCollectorAddress ?? FEE_COLLECTOR_ADDRESS` | REPORT | A mainnet-literal fallback on a multi-chain path. **Currently safe** — guarded by the `:321-323` throw (`routeViaFeeCollector && !feeCollectorAddress → throw`) so the fallback is unreachable with a null chain address. Defensive nit: drop the mainnet literal and fail-closed (W4-adjacent). |

## Negative-path battery (each refused)
Signature over a modified payload → impossible (confirm/sign read the frozen state; no rebuild) ✅ ·
same-chain replay → nonce single-use ✅ · cross-chain replay → distinct on-chain domain separators
(`0x335a…` vs `0x020a…`) ✅ · chain switched mid-review → review cleared (`p.chainId!==chainId` guard) ✅ ·
forged/absent admin Bearer → `verifyBearerToken` false ✅ · timing side-channel → `timingSafeEqual` ✅ ·
recipient=attacker in calldata → client R1 block before freeze + server R1 ✅ · CoW order expired pre-sign
→ 9U freshness refuse ✅ · infinite approval → exact-amount only ✅.

## Coverage (signing slice)
- All 9 signing/tx call sites on `main` enumerated + each mapped to its review-gate (table above).
- Bearer: `auth.ts` + `api-auth.ts` reviewed (constant-time); secret-logging grep clean.
- On-chain: both executor domain separators re-confirmed distinct (chain-pinned).
- Not run in-sandbox: live wallet signature tap / real-device flow (human-only boundary) — reasoned from
  the frozen-payload code path; `forge` cross-chain-replay fork-test deferred to CI.

## Remediation prompts
1. **W5-I-02 — remove the `?? FEE_COLLECTOR_ADDRESS` mainnet fallback** in `useSwap.ts:341`; rely on the
   `:321` fail-closed guard (or throw explicitly). Frontend-only; add a test asserting a null per-chain
   FeeCollector never yields a mainnet address in the built tx. (W5-I-01 needs no action.)

## Boundaries
Read-only on `origin/main`; no live signatures/real-device/deploys (human-only). W6 (API) + W8 (keeper)
consume: swap/order payloads are frozen-then-signed; Bearer is constant-time; the keeper's executeOrder
signing trust is W8.
