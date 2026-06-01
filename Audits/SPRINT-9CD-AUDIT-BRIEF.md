# TeraSwap — Sprint 9C/9D Audit Brief (Auditor agent prompt)

**Scope:** Two Base/multi-chain changes — (A) on-chain adapter chain-awareness hotfix, and
(B) Bebop as the 12th source (ETH + Base). Review for correctness, fund-flow safety, and
secret handling. Classify every finding by severity **C / H / M / L**. **0C / 0H = APPROVED.**
Produce remediation prompts for the Code Agent — **do NOT edit code directly.**

**Commits under review:**
- 9C on-chain fix: `c8ca8b1` (signed; 1296 tests, 6-agent review 0 findings)
- P228 Bebop: `3d938d4` (signed; 1307 tests, 5-agent review 0 findings)
- Baseline: `98e9df0` (debug=sources diagnostic, 1283 tests passing)

**Specs the changes must conform to:**
- `docs/Prompts/SPRINT-9C-onchain-chain-aware.md`
- `docs/Prompts/SPRINT-9D.md` + `docs/ADR/ADR-010-bebop-rfq-source.md`

**Mandatory pre-checks (CLAUDE.md):** confirm no open C/H in `docs/security/AUDIT-TOTAL.md`;
every commit GPG/SSH-signed; CI (lint, typecheck, test, audit) green; `FEEDBACK.md` updated.

---

## Area A — On-chain adapters chain-aware (Sprint 9C) — priority: HIGH (correctness/fund-safety)

**Why it matters:** the bug returned a **mainnet-priced** Uniswap quote on Base. A wrong quote
that a user then executes is a direct fund-loss vector, so treat residual mis-routing as HIGH.

**Files:** `src/lib/adapters/shared.ts`, `src/lib/adapters/uniswapv3.ts`,
`src/lib/adapters/curve.ts`, the new per-chain address registry, related tests.

**Key questions for the auditor:**
1. Is the mainnet (chainId 1) RPC path **byte-identical** to pre-change (incl. the `/api/rpc`
   privacy proxy)? Prove it via tests/diff, not assertion.
2. Can `uniswapv3` or `curve` reach a **mainnet RPC or mainnet contract** under any code path
   when `chainId !== 1` (default args, fallback branches, error paths, retries)? It must not.
3. Are the Base Uniswap V3 addresses (QuoterV2, Factory, SwapRouter02) **verified on Basescan /
   official Uniswap base deployments**, and do they match the whitelist in `chains/routers.ts`?
4. Does `curve` truly **fail closed** off-mainnet (returns null/skips, **zero** RPC calls)? Any
   way it silently quotes a wrong pool?
5. Does the new `getRpcUrlForChain()` correctly handle an empty/unset Base RPC
   (`getChainConfig(8453).rpc.primary === ''`) — fail clean, not hang or fall back to mainnet?
6. Test adequacy: is the "no mainnet-priced quote on Base" regression actually covered?

## Area B — Bebop 12th source (P228) — priority: HIGH (new external dependency + fund flow)

**Files:** `src/lib/adapters/bebop.ts` (new), `src/lib/constants.ts`,
`src/lib/chains/adapter-urls.ts`, `src/lib/chains/routers.ts`, `src/lib/adapters/index.ts`,
`src/lib/api.ts`, `.env.example`, related tests.

**Key questions for the auditor:**
1. **Whitelist gate (critical path):** does the adapter assert `tx.to === settlementAddress`
   AND that both `settlementAddress` and `approvalTarget` are in `getRouterWhitelist(chainId)`
   for chains 1 and 8453, and **reject (throw) otherwise**? Try to construct a response that
   passes a tampered `to`/`approvalTarget`. Confirm fail-closed.
2. **Secrets:** are `BEBOP_API_KEY` / `BEBOP_SOURCE` server-only (no `NEXT_PUBLIC_`, never in
   client bundles, never logged or returned)? Grep the built client output.
3. **Fee model:** is `bebop` in `FEE_INCOMPATIBLE_SOURCES` so the FeeCollector path is skipped,
   and is our fee taken **once** via Bebop `fee`/`fee_recipient` (no double fee, no zero fee, no
   fee routed to a wrong/empty recipient)? Is `fee_recipient` our real fee wallet, env-driven?
4. **approvalTarget vs settlement:** does `fetchApproveSpender` resolve Bebop's approval to the
   **Balance Manager** (`approvalTarget`), not the settlement contract, not the FeeCollector?
   A wrong approval target = user funds approved to the wrong contract.
5. **Recipient integrity:** does `receiver_address` default to sender and is it validated by the
   existing calldata-recipient check on Bebop's tx? Any way output routes to an attacker?
6. **value/amount parsing:** is `tx.value` hex (`0x0`) normalized correctly to our decimal-string
   model? Is `minimumAmount` / slippage honoured (no silently-zero min-out)?
7. **Positional array fix:** is the `api.ts` source-name array now aligned with `ADAPTER_REGISTRY`
   (12 entries, correct order) so per-source error attribution is right?
8. **Placeholder taker:** for price-only `fetchQuote` (no wallet), does the placeholder taker
   create any risk, and does Bebop's demo-mode (no key) ever leak into production as a real quote?
9. **No regression:** are the other 11 sources, fee logic, and ordering unchanged (test-guarded)?

## Cross-cutting checks
- CLAUDE.md rule #9: Chainlink price validation still applies to Bebop swaps at execution (Bebop
  is a single external quote source — it must not bypass the mandatory Chainlink sanity check).
- No new unbounded loops / O(n²) on the 12-source fan-out; circuit breaker + timeout still wrap
  the new adapter.
- `FEEDBACK.md`: triage every item the Code Agent raised (e.g. placeholder-taker behaviour).

---

## Deliverable from the Auditor
A findings table (ID, severity C/H/M/L, file:line, description, suggested fix) **plus** one
Code Agent remediation prompt per C/H finding (Context/Objective/Requirements/Do NOT/Files/
Expected/Quality). Verdict: **APPROVED** only if 0C/0H. Record the verdict and update
`docs/security/AUDIT-TOTAL.md` and ops-state after close.
