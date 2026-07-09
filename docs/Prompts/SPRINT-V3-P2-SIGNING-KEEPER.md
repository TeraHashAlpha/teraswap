# SPRINT-V3-P2-SIGNING-KEEPER — v3 signing flow (frontend + API) and keeper dual-executor migration

> **Source:** ADR-013 deploy plan step 4 (migration) + AUDIT-V3-P1-EXECUTOR (2026-07-09, APPROVE-TO-MERGE) which
> scopes **I-01/L-01 off-chain closure here**: USD-min at signing + `/api/orders` dust rejection. The v3 struct/ABI
> is frozen and audit-approved (SHA `954c415`): `maxSlippageBps` (uint16, ≤500), real absolute `minAmountOut`,
> EIP-712 domain version "3", Permit2 bitmap nonces, non-DCA real `routerDataHash`. **v3 is NOT deployed yet** —
> everything here is config-driven and **fail-closed while the per-chain v3 address is null.** Owner decision
> 2026-07-09: no-feed pairs allowed with a signed absolute min → the decay mitigations below are mandatory.
> Fund-flow-adjacent (signing + keeper) → **Auditor-gated: PR UNMERGED until 0C/0H.** SSH-signed; branch
> `sprint/v3-p2-signing-keeper` off latest `origin/main` (post-P1-merge) in a dedicated worktree; 5 droppable
> commits. Parallel-safe with `chore/v3-audit-followups` (disjoint files — do not touch the .sol/its tests).

## Requirements (per-commit)

### 1. Per-chain v3 config (fail-closed)
`ChainConfig`/env: `ORDER_EXECUTOR_V3` address per chain (+ `NEXT_PUBLIC_*` for signing), **null = v3 signing
disabled on that chain** (v2 flow untouched). EIP-712 v3 domain module (version "3", per-chain
`verifyingContract`, chainId) + v3 typehash mirroring the audited struct. No two chains share a
`verifyingContract`; no gate may treat "v3 configured" as implied by anything else (explicit address only).

### 2. Signing flow (DCAPanel + useOrderEngine) — N2, kills the 1-wei signing
- Add `maxSlippageBps` to order creation: default **300** (mirrors the Phase-0 keeper band), user-adjustable,
  hard-capped at **500** client-side (contract enforces anyway).
- **Derive the absolute `minAmountOut` at signing** from a reference price (Chainlink first, else DefiLlama — the
  same plumbing the keeper floor uses) × (1 − maxSlippageBps): never sign `'1'` again. Show the derived floor.
- **No-feed pair UX (owner decision):** allow, but show the decay warning (fixed min loses meaning over a long
  DCA: price up → strands, price down → weak floor) and surface the order's expiry as the bound.
- Non-DCA (parked panels) — types only; no re-wire in this sprint.

### 3. `/api/orders` validation — closes I-01 + L-01 off-chain
Reject: `maxSlippageBps` absent/0/>500; `minAmountOut` below a **USD-denominated dust floor** (price the tokenOut
leg; unpriceable BOTH sources → reject creation, fail-closed, mirroring the P2 gate pattern); expiry/period
coherence unchanged. Server-side — never trust the client derivation.

### 4. Keeper dual-executor migration (ADR-013 step 4)
`executor.js` + route/build path: select executor + ABI per order (v2 vs v3 by `verifyingContract`/version field),
v3 ABI import; v2 keeps executing existing orders until drained/cancelled; v3 orders only when the per-chain v3
address is configured — otherwise **skip + flag, never mis-route**. Phase-0 `order-floor.js` +
`submission-policy.js` stay ACTIVE and UNCHANGED for both executors (interim per ADR until v3 live everywhere).
No new key-handling paths (KMS only; no `ALLOW_PLAINTEXT_KEY`).

### 5. Tests
Signing: derived min ≠ 1, cap enforced, no-feed warning path, null-address → v3 UI absent (fail-closed, no leak —
the Base-pre-launch pattern). API: dust/unpriceable/cap rejections. Keeper: v2/v3 routing matrix incl.
v3-unconfigured skip+flag; floor/submission policy untouched (regression).

## Do NOT
Touch `TeraSwapOrderExecutorV3.sol` or its tests (parallel chore owns them); deploy anything; re-wire Limit/SL·TP
panels; weaken SC-04/R1 or the order gates (`NEXT_PUBLIC_DCA_ENABLED` gate untouched); no wagmi-v3; no
`ALLOW_PLAINTEXT_KEY`; no secrets in code.

## Files affected (read ONLY these)
`src/lib/chains/**` (config), the EIP-712/order-types module, `DCAPanel.tsx`, `useOrderEngine.ts`,
`app/api/orders/**`, keeper `executor.js` + ABI/config modules, `.env.example` (names only),
`docs/Prompts/SPRINT-V3-P2-SIGNING-KEEPER.md` (commit this spec). Read-only reference:
`TeraSwapOrderExecutorV3.sol` (ABI source), ADR-013, `order-floor.js`, `submission-policy.js`.

## Expected output
Branch + PR, CI green (push + report, don't poll), vitest suite green. FEEDBACK ≤1 screen: derivation mechanism,
dust-floor choice, keeper routing matrix, any struct/ABI mismatch found (would be a P1 escalation).
**Flag for Auditor (fund-flow) — do NOT merge.**

## Quality criteria
Signing can never produce a 1-wei min; every v3 path is fail-closed while unconfigured; the keeper cannot send a
v3 order to v2 or vice-versa; Phase-0 protections provably unchanged; I-01/L-01 closed off-chain.

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

SPRINT-V3-P2-SIGNING-KEEPER per docs/Prompts/SPRINT-V3-P2-SIGNING-KEEPER.md (commit the spec in this PR). Branch sprint/v3-p2-signing-keeper off origin/main (post-V3-P1 merge) in a DEDICATED worktree, SSH-signed, CI green. FUND-FLOW-ADJACENT (signing + keeper) -> Auditor-gated: PR UNMERGED until 0C/0H. v3 is NOT deployed: everything config-driven, FAIL-CLOSED while the per-chain v3 address is null. Do NOT touch TeraSwapOrderExecutorV3.sol or its tests (a parallel chore owns them).

Context: v3 struct/ABI frozen + audit-approved (954c415): maxSlippageBps uint16 <=500, real absolute minAmountOut, EIP-712 domain version "3" per-chain verifyingContract, Permit2 bitmap nonces. Audit scopes I-01/L-01 off-chain closure HERE (USD-min at signing + /api/orders dust rejection). Owner: no-feed pairs allowed w/ signed absolute min -> decay mitigations mandatory.

Commits (droppable, in order):
1. Config: ORDER_EXECUTOR_V3 per chain (+NEXT_PUBLIC_* for signing), null = v3 signing disabled (v2 flow untouched). EIP-712 v3 domain module (version "3", per-chain verifyingContract, chainId) + typehash mirroring the audited struct. No two chains share a verifyingContract; v3-enabled = explicit address ONLY.
2. Signing (DCAPanel.tsx + useOrderEngine.ts): add maxSlippageBps (default 300 = Phase-0 band, user-adjustable, client cap 500); DERIVE absolute minAmountOut at signing from a reference price (Chainlink first, else DefiLlama — same plumbing as the keeper floor) x (1 - maxSlippageBps); NEVER sign '1' again; show the derived floor. No-feed pair: allow + decay warning (fixed min: price up -> strands, down -> weak floor) + surface expiry as the bound. Non-DCA: types only, NO panel re-wire.
3. /api/orders validation (closes I-01+L-01 off-chain): reject maxSlippageBps absent/0/>500; reject minAmountOut below a USD dust floor (price tokenOut; unpriceable on BOTH sources -> reject creation, fail-closed, P2-gate pattern); server-side, never trust client derivation.
4. Keeper (executor.js + ABI/config): dual-executor routing — select executor+ABI per order (v2 vs v3 by verifyingContract/version); v2 drains existing orders; v3 orders ONLY when the chain's v3 address is configured, else SKIP + FLAG (never mis-route). order-floor.js + submission-policy.js stay ACTIVE and UNCHANGED for both. KMS only, no ALLOW_PLAINTEXT_KEY.
5. Tests: signing (derived min != 1, cap, no-feed warning, null address -> v3 UI absent = fail-closed, Base-pre-launch pattern); API rejections (dust/unpriceable/cap); keeper routing matrix incl. unconfigured-skip; floor/submission-policy regression (untouched).

Do NOT: touch the .sol/forge tests; deploy; re-wire Limit/SL-TP; weaken SC-04/R1 or the NEXT_PUBLIC_DCA_ENABLED gate; wagmi-v3; secrets in code.

Files: src/lib/chains/**, EIP-712/order-types module, DCAPanel.tsx, useOrderEngine.ts, app/api/orders/**, keeper executor.js + ABI/config, .env.example (names only), docs/Prompts/SPRINT-V3-P2-SIGNING-KEEPER.md. Read-only: TeraSwapOrderExecutorV3.sol (ABI source), ADR-013, order-floor.js, submission-policy.js.

Expected: PR open, CI green (push + report). FEEDBACK <=1 screen: derivation mechanism, dust-floor choice, keeper routing matrix, any struct/ABI mismatch (escalate — would be a P1 finding). Flag for Auditor (fund-flow) — do NOT merge.
```
