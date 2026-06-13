# MEGA-AUDIT 2026-06-11 — full-system, layered quality & safety review + controlled fixes

This is a DEFENSIVE engineering quality review of TeraSwap's OWN codebase, run by the project owner to
find and fix defects and to verify the product's existing safety protections hold. The goal is
correctness, reliability, and hardening — standard QA / code-review work, at depth.

You are the **orchestrator**. Spend the budget — fan out many review subagents in LAYERS, check code
AND logic, and FIX what is safe to fix under the guardrails below. Read `CLAUDE.md` first (roles,
conventions, the 12 "Do NOT" rules) — they bind this review.

## Goal
Across contracts, backend, frontend, safety gates, wallet layer, adapters, dependencies, infra, and
tests: find every correctness/reliability/robustness defect, FIX the safe ones (with tests), and write
remediation prompts for the ones that need human review. Output one master report + a RICE-ranked plan
+ branches/PRs for the fixes + prompts for the rest.

## Defect classes to review for (we hit several of these this month — look for MORE)
1. **Chain-aware correctness (top priority).** Find any code that assumes mainnet (chainId 1, a
   mainnet RPC/client, etherscan, a mainnet token/feed/spender) on a code path that ALSO runs on Base.
   This has been the most common defect (sprints 9C/9G/9P/9Q/9S/9W). Review every file for mainnet
   assumptions on multi-chain paths and make them chain-aware.
2. **Dependency robustness.** Confirm the lock resolves a SINGLE instance of each critical dependency
   (@walletconnect/core, @coinbase/wallet-sdk, qr, viem); flag over-loose semver ranges that could let
   a transitive bump break or change the build (we hit qr@0.6.0, ua-parser-js license, duplicate WC
   cores). Recommend tighter pins where warranted.
3. **Signing-trust completeness.** Verify that EVERY wallet signature path (transaction OR EIP-712)
   shows the user a TeraSwap review of the exact frozen payload before signing (swap/create/cancel are
   covered by 9R/9U/cancel-review — confirm there are no remaining un-reviewed signature paths, e.g.
   CoW order signing, permits, approvals).
4. **Safety-gate correctness (verify they hold, do not weaken).** For each protection — Chainlink
   validation, per-feed staleness (9V), composed cbETH, the depeg notice (9W), DefiLlama check,
   sequencer check, cross-quote/quorum — confirm it is chain-aware, that no code path silently skips
   it, and that it correctly REJECTS bad/stale/inconsistent prices. Verify oracle feed ADDRESSES
   on-chain (description()/aggregator()), not by directory name (that misled us in 9V).
5. **Fund-flow integrity (verify the protections work).** Confirm the router whitelist + function-
   selector allowlist + recipient gating + on-chain minimumOutput + FeeCollector routing +
   FEE_INCOMPATIBLE handling + partner fees together guarantee: output always lands with the user, the
   0.1% fee is applied exactly once (never skipped, never doubled), and unrecognized routers/selectors
   are rejected. Test the negative paths (malformed/unexpected inputs are refused).
6. **Robust error handling & env hygiene.** Confirm API error paths return JSON (never an HTML page),
   no server secret is exposed via NEXT_PUBLIC_, and Preview/prod env differences don't cause silent
   misbehaviour.

## Layered review architecture (fan out widely)
**Layer 0 — Recon (1–2 agents):** map the repo (contracts, app/api, hooks, lib, components, chains,
adapters, config, .github, contracts/order-engine); list the invariants/gates each later agent checks.
No edits.

**Layer 1 — Domain reviews (one or more agents EACH, parallel, read-mostly):**
- A. **Smart contracts** (FeeCollector, OrderExecutor): access control, reentrancy protection,
  router-whitelist timelock, selector handling, minimumOutput, sweep, EIP-712 domains/nonces, the
  Augustus whitelist, ETH/ERC20 paths, fee math. Run `forge test` (the real gate). **No contract
  SOURCE edits** — findings become remediation prompts only (rules #2/#3).
- B. **Backend / API** (/api/swap, /api/quote, /api/rpc, /api/spender, /api/v1/swap, portfolio,
  analytics, log-*, health, monitor): input validation, rate limiting, the privacy proxy, chainId
  handling, error→JSON, env/secret handling, Supabase RLS isolation.
- C. **Safety gates / oracle / price** (per defect class 4) — verify feed addresses on-chain.
- D. **Wallet / connection / signing-trust** (per class 3): wagmi/RainbowKit/WC, single-core + qr
  pins, wallet list, WalletSessionGuard, COOP, mobile lifecycle, review modals. Reconcile with ADR-008.
- E. **Adapters / aggregation** (12 sources): calldata-decoder + recipient gate + selector allowlist +
  per-chain URLs + fee routing + 9O fallback + partner fees.
- F. **Frontend / swap flow**: SwapBox, simulation, slippage/min-output, token catalog (9Y), chain
  selector, balances, receipts, USD — review for chain-aware correctness + clear UX.
- G. **Dependencies / supply chain** (per class 2).
- H. **Infra / config / CI / headers**: Vercel env scopes, CSP/COOP/security headers, gitleaks, the CI
  gates (test-contracts is now a real blocking gate), Cloudflare worker, secret hygiene.
- I. **Tests / coverage**: find untested critical paths (esp. Base, order engine, gates, fund-flow).

**Layer 2 — Safeguard verification (negative-path / robustness, 4–6 agents):** for each documented
protection, verify it HOLDS by checking that malformed, stale, inconsistent, or unexpected inputs are
correctly refused and that the documented invariants cannot be violated through the app's normal code
paths. This is defensive negative-path QA of TeraSwap's own safeguards — confirm: bad/stale oracle
prices are rejected; output is always gated to the user; the fee is applied exactly once; nonces
prevent re-use; RLS isolates users; unrecognized calldata is refused; chain handling is consistent
across the codebase. Also hunt cross-domain inconsistencies (a protection applied here but missed
there).

**Layer 3 — Synthesis + controlled fixes (orchestrator + fix agents):** dedupe + consolidate findings
into one report; classify C/H/M/L/I; RICE-rank; then fix/escalate per the rules below.

## Fix rules (fix the safe, escalate the rest — never silently change risk)
- **Safe to FIX on a branch (with TDD + CI green):** frontend, config, tests, docs, non-gate logic,
  chain-aware-correctness fixes that keep mainnet byte-identical, dependency pins. One atomic SSH-signed
  commit per fix; mainnet byte-identical unless the fix IS the mainnet behaviour, test-guarded.
- **ESCALATE (do NOT auto-change) → write a remediation prompt + flag for the human Auditor:** anything
  touching smart-contract SOURCE, fund flows, or a safety gate (oracle/staleness/depeg thresholds,
  FeeCollector routing, selector allowlist). Rules #2/#3: no contract/fund-flow change without an
  Auditor pass; never deploy without 0C/0H. The real `test-contracts` gate stays green; do NOT weaken
  or disable any gate.
- **Critical / High findings:** do NOT auto-fix — remediation prompt + URGENT flag.
- Never weaken a protection to make something pass. No hardcoded secrets / no NEXT_PUBLIC_ server
  secrets. Marketing stays out of the repo (rule #10). Every commit signed (rule #12).

## Evidence discipline
Every finding: file:line, why it's a defect, severity, suggested fix, effort — backed by reading the
code / running a test / an on-chain read, not assumption. Verify token/feed/router ADDRESSES on-chain,
never by name.

## Output
1. `Audits/FULL-AUDIT-2026-06-11.md` — exec summary, findings table (C/H/M/L/I, file:line, disposition
   FIXED-PR#/ESCALATED-prompt), a parity/coverage view, and a **RICE-ranked remediation plan** split
   into "auto-fixed (PRs)" vs "needs human Auditor / contract sprint".
2. Branches/PRs for every safe auto-fix (signed, CI green incl. test-contracts).
3. Remediation prompts (Code-Agent-ready) for every Critical/High and every contract/gate/fund-flow
   finding.
4. Append FEEDBACK with anything the review method surfaced.
Stop at human-only boundaries (real-device wallet testing, live signatures, on-chain governance,
deploys) — do everything automatable, document the human steps, no loop.
