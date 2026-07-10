# CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION — fix the 9 dead 42161 addresses + pin the FULL address set

> **Source:** AUDIT-ARBITRUM-46-47 verdict 2026-07-09: **BLOCK (3 HIGH)** on PR #303. Nine recon-sourced
> `CHAIN_CONFIGS[42161]` addresses have ZERO code on Arbitrum: tokens USDT/DAI/WBTC (config values are corrupted
> variants of the real ones), the sequencer uptime feed, and ALL 5 Chainlink feeds (ETH/USD, USDC/USD, DAI/USD,
> USDT/USD, WBTC/USD). #303's re-verification covered only the router/adapter set (all correct, keep); the
> regression guard pins routers only. **Root cause is systemic: hand-transcribed hex drifts** — from now on
> address values flow PROGRAMMATICALLY from verified on-chain reads into config, never retyped.
> Work **on the existing branch `sprint/47-arbitrum-activation-prep`** (new droppable SSH-signed commits on
> PR #303 — the PR was blocked, not approved-at-SHA). PR stays UNMERGED pending a **fresh joint 46+47 Auditor
> pass** at the new SHA. No activation, no deploy, no env flips.

## Requirements (per-commit)

### 1. Fix the 9 dead addresses — the METHOD is the deliverable
For each of: USDT, DAI, WBTC (tokens); sequencer uptime feed; ETH/USD, USDC/USD, DAI/USD, USDT/USD, WBTC/USD
(Chainlink feeds):
- Resolve from the OFFICIAL source (Chainlink's Arbitrum feed registry/docs for feeds + sequencer; issuer docs /
  Arbiscan verified-token listing for tokens).
- Verify on-chain from **two independent Arbitrum RPCs** (assert `chainId == 0xa4b1` on both): tokens →
  `eth_getCode` non-empty + `symbol()`/`decimals()` match expectations; feeds → `latestRoundData` fresh +
  `description()` matches the claimed pair + `decimals()`; sequencer feed → `latestRoundData` with uptime
  semantics (answer ∈ {0,1}, startedAt sane).
- **Never retype hex:** a small verification script performs the reads and emits the exact address strings; the
  config values are copied programmatically from its output (paste-of-fetched-string, no manual keying). Treat
  any hand-typed address as suspect by policy.

### 2. Pin the FULL 42161 address set (closes the "unguarded" HIGH)
- Emit a machine-readable **`docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`** from the verification run: every
  `CHAIN_CONFIGS[42161]` address (tokens incl. WETH/USDC/wstETH, feeds, sequencer feed, Permit2, CoW relayer,
  Augustus V6.2, UniswapV3 set, Sushi, 1inch, 0x, Kyber, OpenOcean, Balancer) with method, RPC pair, block, and
  result per entry.
- Extend the regression guard to assert `CHAIN_CONFIGS[42161] === manifest` for EVERY address — any silent
  change to ANY 42161 address fails CI (not just routers).

### 3. Report + runbook updates
- Extend/rename the verification report to **`ARBITRUM-ADDRESS-VERIFICATION.md`** covering the full set
  (routers kept from #303 + the 9 fixes with old→new table + the controls), per-address proof lines.
- `ARBITRUM-FEECOLLECTOR-DEPLOY.md` pre-flight gains: "manifest verification run passes at a fresh block" as a
  hard step before deploy.
- Commit this spec.

## Do NOT
Change any router/adapter value validated by the audit (include them in the manifest as-is); flip envs; deploy;
touch activation logic beyond the guard test; touch v3 files; hand-type any hex literal.

## Files affected (read ONLY these + new)
`src/lib/chains/**` (the 9 values + guard test), the verification script location used by #303, **new**
`docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json`, `docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md` (extends the
router report), `docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md` (pre-flight step),
`docs/Prompts/CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION.md`. Read-only: the audit review on #303 (the 9 findings +
true USDT/DAI examples), `docs/Reports/ARBITRUM-READINESS.md` (untrusted, reference only).

## Expected output
PR #303 updated, CI green (push + report, don't poll). FEEDBACK ≤1 screen: the 9-row old→new table with proof
(method/RPCs/block), manifest entry count, guard coverage confirmation. **Flag for the FRESH joint 46+47 Auditor
pass at the new SHA — do NOT merge.**

---

### `/goal` paste for the Code Agent (≤4000)
```
CONTROL: model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the listed files · FEEDBACK <= 1 screen.

CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION per docs/Prompts/CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION.md (commit the spec in this PR). Work ON THE EXISTING branch sprint/47-arbitrum-activation-prep (PR #303 — BLOCKED by the joint audit, 3 HIGH). New droppable SSH-signed commits on top; PR stays UNMERGED pending a FRESH joint Auditor pass at the new SHA. No activation, no deploy, no env flips.

Context: 9 recon-sourced CHAIN_CONFIGS[42161] addresses have ZERO code on Arbitrum — tokens USDT/DAI/WBTC (corrupted variants of the real ones), the sequencer uptime feed, and ALL 5 Chainlink feeds (ETH/USD, USDC/USD, DAI/USD, USDT/USD, WBTC/USD). Routers/adapters from #303 are all CORRECT — do not change them. Root cause: hand-transcribed hex drifts. THE METHOD IS THE DELIVERABLE: addresses flow programmatically from verified reads into config — never retype hex.

Commits (droppable, in order):
1. Fix the 9 addresses: resolve each from its OFFICIAL source (Chainlink Arbitrum feed registry/docs for feeds + sequencer; issuer docs/Arbiscan verified listing for tokens); verify on-chain from TWO independent Arbitrum RPCs (assert chainId==0xa4b1 on both): tokens => eth_getCode non-empty + symbol()/decimals() match; feeds => latestRoundData fresh + description() matches the pair + decimals(); sequencer => latestRoundData uptime semantics (answer in {0,1}, startedAt sane). A small verification script emits the exact address strings; config values are copied from its output programmatically — NO manual keying of hex, anywhere.
2. Pin the FULL address set: emit docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json from the verification run — EVERY CHAIN_CONFIGS[42161] address (tokens incl. WETH/USDC/wstETH, all feeds, sequencer, Permit2, CoW relayer, Augustus V6.2, UniswapV3 set, Sushi, 1inch, 0x, Kyber, OpenOcean, Balancer) with method + RPC pair + block + result. Extend the regression guard: CHAIN_CONFIGS[42161] === manifest for EVERY address — any silent change to ANY 42161 address fails CI (not routers-only).
3. Reports/runbook: extend the router report into docs/Reports/ARBITRUM-ADDRESS-VERIFICATION.md (full set; 9-row old->new table + controls; per-address proof lines). ARBITRUM-FEECOLLECTOR-DEPLOY.md pre-flight gains a hard step: "manifest verification run passes at a fresh block" before deploy. Commit the spec.

Do NOT: change any audit-validated router/adapter value (manifest them as-is); flip envs; deploy; touch activation logic beyond the guard test; touch v3 files (parallel arc); hand-type hex.

Files: src/lib/chains/** (9 values + guard test), the #303 verification script, NEW docs/Reports/ARBITRUM-ADDRESS-MANIFEST.json + ARBITRUM-ADDRESS-VERIFICATION.md, docs/Runbooks/ARBITRUM-FEECOLLECTOR-DEPLOY.md (pre-flight), docs/Prompts/CHORE-47B-ARBITRUM-ADDRESS-REMEDIATION.md. Read-only: the audit review on #303, ARBITRUM-READINESS.md (untrusted reference).

Expected: PR #303 updated, CI green (push + report). FEEDBACK <=1 screen: 9-row old->new table w/ proof (method/RPCs/block), manifest entry count, guard coverage. Flag for the FRESH joint 46+47 Auditor pass at the new SHA — do NOT merge.
```
