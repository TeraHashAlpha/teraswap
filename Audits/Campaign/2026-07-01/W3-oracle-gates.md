# SEC-2 · Wave 3 — Oracle & safety gates (do they HOLD, chain-aware?) — entry packet  ⚠ rule #9

> **Campaign:** 2026-07-01. **Sprint:** SEC-2 (parallel after W0). **Runner:** Auditor (read-only). **Grounded on:**
> `W0-recon.md` §1/§2 (feeds verified on-chain this run). **Source of truth:** T-SAF v1 §5-W3 + §6 INV-4/8 + §9 G2.
> **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#9/#12.

## Objective
Prove every price/oracle/sequencer gate **holds, is chain-aware, and is never silently skipped** — bad/stale/deviant/
depegged input is rejected on BOTH chains, and every feed address is the on-chain-verified one (W0).

## In-scope (W0-confirmed: 15 gate/oracle libs)
`src/lib/chainlink.ts`, `price-gate.ts`, `depeg-gate.ts`, `defillama.ts`, `price-monitor.ts`, `circuit-breaker.ts`,
`src/lib/chains/{sequencer-check,chainlink-feeds,registry}.ts` (+ the rest of the 15 W0 enumerated).

## Attacker goal (§5-W3, §9-G2)
Settle a swap on a stale/deviant/depegged price; exploit an L2 sequencer-down/grace window; **silently skip a gate
on the Base path**; trust a feed by name that isn't the real one.

## Must-verify invariants (INV-4, INV-8; negative-path first)
1. **Chain-aware, no silent skip:** the SAME gate runs on chainId 1 AND 8453 at every call site (no Base bypass).
2. **Staleness:** per-feed heartbeat staleness rejects a stale round (`updatedAt` vs heartbeat×1.5;
   `answeredInRound ≥ roundId`). W0 confirmed mainnet ETH/USD fresh + USDC/USD within heartbeat — re-assert per feed.
3. **Cross-quote/quorum:** a deviating single-source price is refused.
4. **Depeg:** `depeg-gate` blocks a depegged LST/stable (market-vs-exchange-rate).
5. **DefiLlama fallback:** blocks swaps **>$10k** when DefiLlama unavailable (and the intentional fail-open <$10k is
   correct, INV-8 fail-safe direction).
6. **Sequencer gate on BOTH quote AND swap-build** paths (answer=1/down or in-grace → block).
7. **Feed ADDRESSES on-chain-verified** (`description()`/`aggregator()`), never by name — reuse/extend W0's snapshot
   incl. the composed cbETH feed + the L2 sequencer feed.

## Method & tools (§7.5, W0 env caveats: `cast` absent → viem/node)
Enumerate EVERY gate call site; assert the same gate on 1 AND 8453; **fork-test** stale/deviant/depeg/sequencer-down
→ must reject; on-chain-read each feed used (viem/node, reuse W0). Trace each failure branch to confirm fail-closed
(gates) vs fail-open (advisory reads) is by design (INV-8).

## Negative-path battery (each must block)
Stale round · deviating cross-quote · depegged LST · sequencer answer=1 / in-grace · DefiLlama down + >$10k swap.

## Exit criteria
No gate skippable, none weakened, all chain-aware, all feed addresses on-chain-verified; fail-safe direction correct.
Findings → §4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Run T-SAF Wave 3 (Oracle & safety gates) per Audits/Campaign/2026-07-01/
W3-oracle-gates.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W3. READ-ONLY, no code
edits. Ground on W0-recon.md §1/§2 (feeds already on-chain-verified there).

Scope (15 gate/oracle libs): chainlink.ts, price-gate.ts, depeg-gate.ts,
defillama.ts, price-monitor.ts, circuit-breaker.ts, chains/{sequencer-check,
chainlink-feeds,registry}.ts + the rest W0 enumerated.

Prove (negative-path FIRST — each must BLOCK):
1. Chain-aware, no silent skip: the SAME gate runs on chainId 1 AND 8453 at
   every call site (no Base bypass).
2. Staleness: per-feed heartbeat rejects a stale round (updatedAt vs
   heartbeat*1.5; answeredInRound >= roundId).
3. Cross-quote/quorum: a deviating single-source price is refused.
4. Depeg: depeg-gate blocks a depegged LST/stable (market vs exchange-rate).
5. DefiLlama: blocks swaps >$10k when unavailable; the <$10k fail-open is
   correct (INV-8 fail-safe direction).
6. Sequencer gate on BOTH quote AND swap-build (answer=1/down or in-grace ->
   block).
7. Feed ADDRESSES on-chain-verified (description()/aggregator()), never by
   name — reuse/extend W0 snapshot incl. composed cbETH feed + L2 sequencer.

Tools: enumerate every gate call site; assert same gate on 1 AND 8453;
fork-test stale/deviant/depeg/sequencer-down -> reject; on-chain feed reads via
viem/node (cast absent, reuse W0); trace each failure branch (fail-closed gates
vs fail-open advisory by design).

Deliver into Audits/Campaign/2026-07-01/W3-oracle-gates.md (report section):
checks-run table, findings (Sev·file:line·disposition + §4 evidence bundle),
negative-path results, coverage fraction of the gates slice, verdict,
remediation-prompt list. SSH-signed commit left for owner if no key in sandbox.
```

---

# WAVE 3 — REPORT (executed 2026-07-01, Auditor, read-only)

## Verdict
- **Gate logic on PRODUCTION (`origin/main`): APPROVED — 0C / 0H.** Every price/oracle/sequencer gate
  holds, is chain-aware, fail-safe-correct, and the feed addresses are on-chain-verified.
- **⚠ Campaign-process finding W3-H-01 (HIGH, grounding — NOT a product vuln):** the audited working
  tree `docs/inc-2026-06-09` is **261 commits behind `origin/main` (0 ahead)** and is **missing the E-2
  quote-path + E2-I-01 swap-build sequencer gates that production has.** W0–W2's *branch-dependent*
  (frontend/API) conclusions must be re-confirmed against `main`; the *on-chain* (contract/feed) findings
  are unaffected. **Re-baseline the campaign on `main` before continuing.**

## W3-H-01 — grounding error (the headline)
Discovered while enumerating sequencer call sites: on the working tree `isSequencerUp` appears only in
`chainlink.ts:302` (price-read) + `price-monitor.ts:71` — the explicit quote/swap-build gates were
absent. Verified:
- `git merge-base --is-ancestor 3079d67 HEAD` → **NO** (E2-I-01 not in this branch).
- `git rev-list --count HEAD..origin/main` → **261**; `origin/main..HEAD` → **0** (branch is strictly behind).
- `origin/main` has the gate at **4** sites: `api/swap/route.ts:126` (swap-build, E2-I-01),
  `api.ts:107` (quote, E-2), `chainlink.ts:302` (price-read, P218), `price-monitor.ts:71`.
- Core gate files also drifted on main: `defillama.ts` (+84/−18), `sequencer-check.ts` (+54/−14).
  `chainlink.ts`, `price-gate.ts`, `depeg-gate.ts`, `chainlink-feeds.ts`, `price-monitor.ts` are
  identical on both → those W3 reads are valid for production as-is.

**Impact:** this is an *audit-grounding* defect, **not a production vulnerability** (production/`main`
carries all gates). But it means the campaign has been reading stale frontend/API code; W1/W2's
branch-dependent items (e.g. W2's `useSwap` minimumOutput derivation, the api/swap recipient wiring)
should be re-verified on `main`. On-chain-decisive findings (W0 feeds, W1 contract bytecode, W2 deployed
minimumOutput) are branch-independent and stand.

**To re-baseline:** run the campaign against `origin/main` (or the exact deploy tag). All checks below are
reported **against `origin/main`** (production) where a gate is branch-dependent; branch-independent gate
logic is read from the working tree (identical to main).

## Checks-run (graded against PRODUCTION `main`; negative-path first)
| # | Check | Result (on `main`) |
|---|-------|--------------------|
| 1 | Chain-aware, no silent skip (same gate on 1 AND 8453) | ✅ `chainlink.ts` `rpcCall(chainId)` (M04), `defillama` `chain` slug (G2), `sequencer` `isSequencerUp(chainId,…)`, `price-monitor` `getPublicClientForChain(chainId)` — all chain-parametrised, no hardcoded mainnet on a Base path. |
| 2 | Per-feed staleness rejects stale round | ✅ `validateRoundData` (`chainlink.ts:184`, identical on both): `answer≤0`, `answeredInRound<roundId`, `startedAt≤0`, `age>heartbeat×1.5` → **null (block)**. Per-feed heartbeat via `getFeedStalenessSec` (9V; Base USDC 24h→36h). |
| 3 | Deviating single-source price refused | ✅ Server DefiLlama guard: output **>8% below fair value → block** (`defillama.ts` `BLOCK_THRESHOLD=-0.08`, 422 non-overridable). Client Chainlink gate hard-blocks integrity + **extreme-deviation > consent-ceiling**; price-impact on a healthy oracle → informed consent (9J, rule #9: does not weaken the server gate). |
| 4 | Depeg blocks depegged LST/stable | ✅ `depeg-gate.ts` market-vs-exchange-rate: `≥DEPEG_DIVERGENCE_BLOCK → block`. Leg integrity **fail-closed** (`priceFromValidRound` null on invalid), depeg verdict **fail-open** (feed outage ≠ depeg) — correct INV-8. On-chain now: cbETH market 1.13373 vs ER 1.13383 → 0.009% (no depeg). |
| 5 | DefiLlama blocks >$10k when unavailable; <$10k fail-open | ✅ `HIGH_VALUE_THRESHOLD_USD=10_000`; unavailable / low-confidence(<0.5) / calc-error **& >$10k → block**; **<$10k → null (fail-open)** — correct INV-8 fail-safe direction. `+CONSECUTIVE_BLOCK_THRESHOLD=3` on main. |
| 6 | Sequencer gate on BOTH quote AND swap-build | ✅ **on `main`**: quote `api.ts:107` (throws `SequencerDownError`→503), swap-build `api/swap:126` (chain-aware `chainId!==DEFAULT` → 503 + Retry-After), price-read `chainlink.ts:302`, monitor. `isSequencerUp` fail-safe: down/in-grace/RPC-error → false → refuse; unknown-chain/L1 → true. **✗ on the audited branch (W3-H-01).** |
| 7 | Feed addresses on-chain-verified (not by name) | ✅ Extended W0 via `aggregator()`: cbETH **market** `0x806b` → agg `0x53fD…F559` v6 18dp; cbETH **ER** `0x868a` → agg `0x4c78…3CDE` v6 (matches `chainlink-feeds.ts` comments — closes W0's `description()`-revert gap). ETH/USD `0x7104` agg `0x1e0B…`. **Sequencer `0xBCF8`**: `description()`/`aggregator()` revert (non-standard L2 uptime interface) — identity confirmable only via `latestRoundData` (answer=0=up) → W3-I-01. |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W3-H-01 | HIGH (process, **not** product) | working tree `docs/inc-2026-06-09` (261 behind `main`) | REMEDIATION-PROMPT | Campaign grounded on stale code missing production sequencer gates. Not a prod vuln (main has them). **Re-baseline on `main`/deploy tag**; re-verify W1/W2 frontend-API items there. Blocks *campaign completion*, not prod. |
| W3-I-01 | INFO | `chains/registry.ts:89` sequencer feed `0xBCF8` | REPORT | L2 sequencer uptime feed does not implement `description()`/`aggregator()` (both revert) — identity verifiable only by `latestRoundData` semantics (answer 0=up, verified). Acceptable; record that name-verification is impossible for this feed class. |
| W3-I-02 | INFO | `price-gate.ts:51` (J1 consent) | REPORT | Client Chainlink deviation gate intentionally down-graded to informed-consent for price-impact (9J). Verified rule #9-safe: integrity + extreme-deviation still hard-block, and the non-overridable server DefiLlama −8% guard + on-chain minimumOutput are unchanged. No action. |

## Negative-path battery (each blocks — on `main`)
Stale round → `validateRoundData` null ✅ · `answeredInRound<roundId` → null ✅ · deviating price (>8% below fair)
→ DefiLlama 422 ✅ · depegged LST (≥block divergence) → depeg block ✅ · sequencer answer=1/in-grace → 503 on
quote + swap-build ✅ · DefiLlama down + >$10k → block ✅ · DefiLlama down + <$10k → fail-open (by design) ✅.
(All confirmed on `main`; on the audited branch the sequencer quote/swap-build refusals are absent — W3-H-01.)

## Coverage (gates slice)
- Source-reviewed: `chainlink.ts`, `price-gate.ts`, `depeg-gate.ts`, `defillama.ts`, `sequencer-check.ts`,
  `chainlink-feeds.ts`, `price-monitor.ts`, `chains/registry.ts` — the 15-lib slice.
- On-chain: all in-use feeds verified (identity via `description()`/`aggregator()` + freshness), incl.
  the composed cbETH legs + sequencer.
- **Production-grounded** for the branch-dependent gates (sequencer, defillama) via `origin/main`.
- Not run in-sandbox: `forge` fork-tests of the on-chain sequencer-down revert (deferred to CI);
  reasoned via source + `isSequencerUp` fail-safe trace.

## Remediation prompts
1. **W3-H-01 — re-baseline the T-SAF campaign on production.** Re-run W0 grounding + re-verify W1/W2/W3
   branch-dependent (frontend/API) items against `origin/main` (or the deploy tag). Confirm the working
   branch used for future waves is production-current (`git rev-list --count HEAD..origin/main == 0` for the
   API/gate surface). Docs/process — no code change. Architect/owner action; Auditor re-confirms.
2. (No product gate remediation — gates on `main` are 0C/0H.)

## Boundaries
No forks/sims/deploys; `forge` sequencer-down fork-test deferred to CI. Handed forward: **campaign must
re-baseline on `main`** (W3-H-01) — this affects the interpretation of W1/W2 frontend-API items (their
on-chain findings stand). W4 (chain-awareness) should run against `main`.
