# SPRINT-V3-P3-CANCEL-AND-HARDENING — the two pre-deploy prerequisites: v3 cancel support + M-01 dust-floor fix

> **Source:** AUDIT-V3-P2-AND-FOLLOWUPS (2026-07-09): #298 approved 0C/0H/0M/0L, #299 approved 0C/0H + **M-01
> (MEDIUM, bounded, non-blocking)** + the adjudicated deviation making **v3 `cancelOrder` + `invalidateUnorderedNonces`
> support a HARD pre-deploy prerequisite** ("do not configure a v3 executor address on any chain before it lands,
> or users will hold uncancellable v3 orders"). Both must close **before V3-P4**. Branch off `origin/main`
> post-#298/#299 merges. Both items are strictly-tightening / wiring to already-audited contract functions →
> **Auditor note in the PR; the formal delta rides the MANDATORY pre-deploy audit at V3-P4 entry** (ADR-013 deploy
> step 2). SSH-signed; branch `sprint/v3-p3-cancel-and-hardening` in a dedicated worktree; 4 droppable commits.

## Requirements (per-commit)

### 1. M-01 fix — `/api/orders` dust floor (route.ts:311-320), exactly per the audit prescription
- **Never trust `body.tokenOutDecimals`:** fetch tokenOut decimals **on-chain, server-side** (chain-aware RPC via
  the ChainConfig registry) and use ONLY that value in the floor math; if the client-supplied value disagrees,
  reject (422) — a decimals mismatch is a malformed/malicious order, not a soft warning.
- **Combine the two USD legs conservatively for a floor gate: `min()`**, not `max()` (the gate must be hardest to
  pass, not easiest).
- **Fail-closed for the single-source no-feed class:** a tokenOut that has NO on-chain USD feed (exactly the case
  where the signed min is the sole on-chain floor) must not pass on one unverifiable estimate — follow the audit's
  rule: on-chain decimals + min-combine + reject when the remaining estimate cannot be validated.
- Regression test reproducing the audit's exploit: spoofed high `tokenOutDecimals` on a DefiLlama-priced/no-feed
  token must now be rejected.

### 2. v3 single-order cancel
Wire `cancelOrder` for v3 orders in the cancel path (`useOrderEngine`/cancel hook + UI): correct per-chain v3
address + ABI from config; **remove the refuse-guard** introduced in #299 only where the real path now exists
(guard stays for any chain whose v3 address is null). v2 cancel flow untouched.

### 3. v3 mass-cancel via `invalidateUnorderedNonces`
Extend cancel-all: compute `wordPos`/`mask` from the user's outstanding v3 order nonces (batch per word); v2 keeps
its existing flow; mixed v2+v3 portfolios cancel both. Unit-fuzz the wordPos/mask math (nonce → bit mapping,
multi-word batching, idempotence on already-invalidated bits). Keeper: no routing change needed (on-chain
cancelled/invalidated checks are authoritative) — add a keeper test asserting a cancelled/invalidated v3 order is
skipped.

### 4. Tests
API: decimals-spoof regression, min-combine, single-source fail-closed, mismatch-reject. Frontend: v3 single
cancel happy-path + null-address guard retained; mass-cancel mask fuzz; v2 regression suite untouched-green.
Keeper: cancelled-v3-skip.

## Do NOT
Touch the contract or forge tests; touch `order-floor.js`/`submission-policy.js`; deploy or configure any v3
address; weaken the #299 fail-closed guards (null-address ⇒ refuse stays wherever v3 is unconfigured); no
wagmi-v3; no secrets.

## Files affected (read ONLY these)
`app/api/orders/**` (route.ts floor block), cancel path in `useOrderEngine.ts` + related hooks/UI components,
keeper test files (routing source read-only), their tests, `docs/Prompts/SPRINT-V3-P3-CANCEL-AND-HARDENING.md`
(commit this spec). Read-only: `TeraSwapOrderExecutorV3.sol` (cancel/invalidate ABI), EIP-712 v3 module,
`src/lib/chains/**`, the #299 audit review.

## Expected output
Branch + PR, CI green (push + report, don't poll). FEEDBACK ≤1 screen: M-01 fix semantics (decimals source,
min-combine, reject rules), the wordPos/mask scheme, and confirmation the refuse-guard remains for unconfigured
chains. **Auditor note in the PR body: delta to be covered by the mandatory V3-P4 pre-deploy audit.**

## Quality criteria
The audit's M-01 exploit is reproducibly rejected; no client-supplied decimals reach any floor math; v3 orders are
cancellable singly and en masse everywhere a v3 address exists, and refusal stays where it doesn't; v2 flows
byte-identical in behavior.

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

SPRINT-V3-P3-CANCEL-AND-HARDENING per docs/Prompts/SPRINT-V3-P3-CANCEL-AND-HARDENING.md (commit the spec in this PR). Branch sprint/v3-p3-cancel-and-hardening off origin/main (post-#298/#299 merges) in a DEDICATED worktree, SSH-signed, CI green. Closes the TWO pre-deploy prerequisites from AUDIT-V3-P2-AND-FOLLOWUPS: M-01 (MED, bounded) + v3 cancel support (HARD prereq — no v3 address may be configured before this lands). Strictly-tightening/wiring to audited contract fns -> Auditor NOTE in PR; formal delta rides the mandatory V3-P4 pre-deploy audit.

Commits (droppable, in order):
1. M-01 fix, /api/orders route.ts:311-320, EXACTLY per the audit: NEVER trust body.tokenOutDecimals — fetch tokenOut decimals ON-CHAIN server-side (chain-aware RPC via ChainConfig); client value disagrees -> 422 reject (malformed order, not a warning). Combine the two USD legs with min() not max() (floor gate = hardest to pass). Single-source no-feed tokens (no on-chain USD feed — where the signed min is the sole on-chain floor): fail-closed when the remaining estimate can't be validated. Regression test reproducing the audit exploit: spoofed high tokenOutDecimals on a DefiLlama-priced/no-feed token -> rejected.
2. v3 single cancel: wire cancelOrder for v3 orders in useOrderEngine/cancel hook + UI (per-chain v3 address + ABI from config); REMOVE the #299 refuse-guard ONLY where a real path now exists (guard STAYS for any chain with null v3 address). v2 cancel untouched.
3. v3 mass-cancel: extend cancel-all via invalidateUnorderedNonces — compute wordPos/mask from the user's outstanding v3 nonces (batch per word); mixed v2+v3 portfolios cancel both; unit-fuzz the wordPos/mask math (nonce->bit, multi-word, idempotence on already-invalidated bits). Keeper: NO routing change (on-chain checks authoritative); add test asserting a cancelled/invalidated v3 order is skipped.
4. Tests: API decimals-spoof regression + min-combine + single-source fail-closed + mismatch-reject; v3 single-cancel happy path + null-guard retained; mask fuzz; v2 cancel regression green; keeper cancelled-v3-skip.

Do NOT: touch the contract/forge tests; touch order-floor.js/submission-policy.js; deploy or configure any v3 address; weaken #299 fail-closed guards; wagmi-v3; secrets.

Files: app/api/orders/** (floor block), cancel path in useOrderEngine.ts + related hooks/UI, keeper TEST files (routing source read-only), their tests, docs/Prompts/SPRINT-V3-P3-CANCEL-AND-HARDENING.md. Read-only: TeraSwapOrderExecutorV3.sol (cancel/invalidate ABI), EIP-712 v3 module, src/lib/chains/**, the #299 audit review.

Expected: PR open, CI green (push + report). FEEDBACK <=1 screen: M-01 semantics (decimals source, min-combine, reject rules), wordPos/mask scheme, refuse-guard confirmed for unconfigured chains. Auditor note in PR body (delta covered by the V3-P4 pre-deploy audit).
```
