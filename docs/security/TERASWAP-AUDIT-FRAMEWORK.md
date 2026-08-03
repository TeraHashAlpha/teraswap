# T-SAF — TeraSwap Total Security Audit Framework (v1)

> **Owner:** Auditor (independent, Opus 4.8). **Status:** Living document. **Output language:** EN
> (interoperates with `AUDIT-TOTAL.md`, the `Audits/Sprint/*` reports, and Code-Agent prompts, all EN).
> **Binding:** `CLAUDE.md` roles + the 12 "Do NOT" rules and `docs/Prompts/AUDITOR-ROLE.md` govern every
> wave. This framework operationalizes them into a **complete, repeatable, adversarial** audit campaign
> that sweeps every attack surface of TeraSwap on **Ethereum mainnet + Base L2**.

This is a **defensive** engineering-security framework for TeraSwap's OWN system. It finds and proves
defects and verifies the product's protections hold. Read-only on source; every finding becomes a
Code-Agent remediation prompt. It is designed to run as **waves (sprints)** that together cover the
whole system, or as targeted single-wave re-runs after a change.

---

## 0. How to use this document

- **Full campaign:** run Wave 0 → Wave 11 in order; Waves 1–10 fan out in parallel where dependencies
  allow (see §7 dependency graph). Each wave emits a packet + findings into `Audits/Campaign/<date>/`.
- **Targeted re-audit:** pick the wave(s) that own the changed surface (use the §2 file→wave map), run
  that wave's scenario set + the cross-cutting invariants (§6) that touch it.
- **Every finding** carries the §4 evidence bundle and lands in the master report + `AUDIT-TOTAL.md`.
- **Approval bar is unchanged:** 0C/0H = APPROVED. Any C/H blocks prod. Contract/fund-flow/gate changes
  additionally require on-chain address verification and never deploy without an Auditor pass (rules #2/#3).

---

## 1. Principles (non-negotiable)

1. **Default-skeptical.** Treat every claim — the sprint's, the docs', AND your own first pass — as
   unproven until backed by a code read at `file:line`, a run test, or an on-chain read. First-pass
   noise runs ~30–40%; refute it explicitly so it isn't re-reported.
2. **On-chain is decisive for addresses.** Routers, oracle feeds, contracts, spenders: verify by
   `cast call` (`description()`/`aggregator()`/`whitelistedRouters`/`code`), never by directory name or
   code label. (9V Augustus / composed-feed lesson: names fooled prior reviewers; the "V5→V6 fix" would
   have BROKEN orders — on-chain showed the contract whitelists V5.)
3. **Read-only on source.** The Auditor never edits code. Findings → Code-Agent-ready remediation
   prompts. The Auditor MAY write reports + `AUDIT-TOTAL.md` (SSH-signed commits, rule #12).
4. **Evidence or it didn't happen.** Every finding: `file:line`, why it's a defect, severity, fix,
   effort — plus the reproduction (test / on-chain read / trace).
5. **Non-destructive & mainnet-safe.** No mainnet writes, no live signatures, no fund movement, no
   deploys. Simulations/forks only. Preserve "mainnet byte-identical" as an invariant to test against.
6. **Adversarial, not checkbox.** Each surface gets a red-team attacker goal, not just a lint. Spin up
   sub-reviewer panels where locality adds rigor (a 4-reviewer panel on E-2 caught an H a light pass missed).
7. **Coverage is the product.** The campaign's value is *completeness of surface* × *depth per surface*.
   Track both: the §2 inventory is the denominator; each wave reports its covered fraction.

---

## 2. Attack-surface inventory (ground truth — the audit denominator)

Grounded in the current tree (not memory). Every item below is owned by exactly one wave (right column).

### 2.1 Smart contracts (on-chain trust root) → **W1/W2**
- `contracts/TeraSwapFeeCollector.sol`, `contracts/TeraSwapFeeCollectorV2_flat.sol` (V2 mainnet, minimumOutput).
- `contracts/order-engine/TeraSwapOrderExecutor.sol` (conditional orders; EIP-712; nonce; Augustus/router whitelist).
- Deployed set (verify on-chain, both chains): FeeCollector V2 mainnet, FeeCollector Base, OrderExecutor.

### 2.2 Safety gates / oracle / price (fund-safety core) → **W3**
`src/lib/chainlink.ts`, `price-gate.ts`, `depeg-gate.ts`, `defillama.ts`, `price-monitor.ts`,
`circuit-breaker.ts`, `src/lib/chains/{sequencer-check,chainlink-feeds,registry}.ts`.

### 2.3 Multi-chain registry / chain-awareness → **W4**
`src/lib/chains/{registry,clients,adapter-urls,routers,activation,tokens,uniswap-v3,index,types}.ts`.

### 2.4 Signing-trust surface → **W5**
EIP-712 order create/cancel (`api/orders`, `api/orders/[id]`), Permit2 approvals, CoW order signing
(`adapters/cow.ts`), swap tx review, `src/lib/auth.ts` + `api-auth.ts` (Bearer), `calldata-recipient.ts`.

### 2.5 Backend / API routes (31) → **W6**
`swap`, `quote`, `v1/swap`, `v1/quote`, `rpc`, `spender`, `orders`, `orders/[id]`,
`orders/[id]/executions`, `orders/stats`, `portfolio/{prices,tokens}`, `history`, `stats`, `analytics`,
`analytics/{export,personal}`, `log-{swap,quote,event,activity}`, `health`,
`monitor`, `monitor/{tick,status,heartbeat,heartbeat/admin,validate-execution}`,
`admin/{kill-switch,api-keys}`, `telegram/webhook`.
Supporting: `kv-rate-limiter.ts`, `rate-limiter.ts`, `validation.ts`, `env-validation.ts`,
`sanitize-error.ts`, Supabase RLS.

### 2.6 Aggregation adapters (12 sources) → **W7**
`adapters/{balancer,bebop,cow,curve,kyberswap,odos,oneinch,openocean,sushiswap,uniswapv3,velora,zerox}.ts`
+ `shared.ts`, `recipient.ts`, `calldata-decoder.ts`, `partner-fee-invariant.ts`, `swap-build-retry.ts`.

### 2.7 Keeper / order engine (off-chain executor) → **W8**
`contracts/order-engine/executor/{executor,alert,freeze-score}.js`, KMS/Vault signing, freeze flag,
outflow detection, Supabase `circuit_breaker`, Cloudflare Worker cron → `monitor/tick`.

### 2.8 Wallet / frontend / session → **W9**
wagmi/RainbowKit/WalletConnect, `WalletSessionGuard`, COOP/COEP, secure storage (Web Crypto),
SwapBox/simulation/slippage/min-output UI, token catalog, review modals, ADR-008.

### 2.9 Supply chain / secrets / infra / CI → **W10**
`package.json`/lockfile + `overrides`, `contracts/order-engine/executor` sub-package lockfile,
`NEXT_PUBLIC_*` scan, security headers/CSP/COOP, gitleaks, GitHub Actions (incl. blocking
`test-contracts`), Vercel env scopes, Cloudflare Worker, Upstash Redis, Supabase keys.

---

## 3. Threat model

### 3.1 Attacker profiles (who we defend against)
- **A1 — Anonymous internet user / malicious caller:** hits public API routes directly (no UI),
  crafts arbitrary bodies/headers/chainIds, replays, floods.
- **A2 — Malicious/compromised liquidity source or router:** returns hostile calldata / quotes aiming
  to redirect funds, inflate fees, or bypass minOutput.
- **A3 — MEV / sandwich adversary:** observes mempool, manipulates price around swaps/oracle reads.
- **A4 — Oracle/market manipulator:** pushes a feed stale/deviant, depegs an LST/stable, exploits a
  sequencer-down window on L2.
- **A5 — Compromised key holder:** keeper KMS key, admin Bearer secret, or contract owner key.
- **A6 — Supply-chain adversary:** poisons a transitive dependency, a build artifact, or a CI step.
- **A7 — Insider/logic drift:** a well-intentioned change that loosens a gate or strands funds
  (the #1 historical source — chain-pinned residue, gate silent-skips).

### 3.2 STRIDE × TeraSwap surface (each cell → a wave scenario)
| STRIDE | Concretely in TeraSwap | Wave |
|--------|------------------------|------|
| **S**poofing | Forged EIP-712 order/permit signatures; spoofed admin Bearer; spoofed recipient in calldata | W5, W2, W6 |
| **T**ampering | Hostile router calldata (recipient/selector/amount); price/quote tampering; chainId coercion | W2, W3, W6, W7 |
| **R**epudiation | Missing/loggable audit trail; nonce reuse enabling double-exec | W1, W6, W8 |
| **I**nformation disclosure | `NEXT_PUBLIC_` secret leak; RLS bypass; secret in logs/URL; error→HTML stack | W10, W6 |
| **D**enial of service | Rate-limit bypass; thundering-herd on cache-miss; freeze-as-DoS; sequencer-window liveness | W6, W3, W8 |
| **E**levation of privilege | Contract access-control; admin route authz; keeper→flag writer; owner-only fns | W1, W6, W8 |

### 3.3 Trust boundaries (where an attacker's input crosses into trust)
1. Browser → API route (untrusted body/headers/query). 2. API → external source/router (untrusted
   calldata/quote back). 3. API/keeper → chain (must enforce on-chain, not just off-chain). 4. Keeper
   KMS → OrderExecutor (signed txs). 5. Admin secret → kill-switch/freeze/api-keys. 6. Dependency/CI →
   build artifact → prod. 7. Supabase RLS → per-user data isolation. Each boundary must **validate,
   gate, and fail safe** — the waves test exactly these crossings.

---

## 4. Severity, evidence, disposition

- **Severity C / H / M / L / I.** **0C/0H = APPROVED.** Any C/H blocks prod. An H safely resolvable
  in-PR → APPROVED-WITH-NOTES (→ APPROVED once the fix + tests land, CI green incl. `test-contracts`).
- **DeFi severity anchors:** *Critical* = direct theft/loss of user or protocol funds, or a gate bypass
  that lets bad price/calldata settle. *High* = conditional loss, fee doubled/skipped, signature replay,
  chain-confusion that misroutes, RLS cross-user read/write. *Medium* = liveness/DoS, info leak w/o
  direct loss, missing defense-in-depth on a covered path. *Low* = hardening, false-confirm, churn.
  *Info* = notes/observations.
- **Evidence bundle (mandatory per finding):** `file:line` · why-defect · severity · attacker path ·
  reproduction (failing test / `cast` read / trace) · suggested fix · effort · **on-chain proof for any
  address**.
- **Disposition:** `FIXED-in-PR` / `REMEDIATION-PROMPT` / `REFUTED` (first-pass noise, explain) /
  `REPORT` (accepted risk / info).
- **RICE** ranks the remediation backlog (Reach × Impact × Confidence / Effort).

---

## 5. The audit campaign — 12 waves

Each wave has: **Objective · In-scope (from §2) · Attacker goals · Must-verify invariants · Method &
tools · Negative-path battery · Exit criteria.** Waves 1–10 run in parallel where §7 allows.

### Wave 0 — Recon & surface baseline (no findings, sets the denominator)
- **Objective:** regenerate the §2 inventory from the *current* tree; diff against last campaign; list
  every invariant each later wave must check; snapshot deployed addresses (both chains) to verify on-chain.
- **Method:** file enumeration; `git` diff since last campaign; build the invariant register (§6);
  pull on-chain deployed bytecode hashes for the byte-identical guard.
- **Exit:** inventory published; every surface item assigned to a wave; no surface unowned.

### Wave 1 — Smart contracts (on-chain trust root)  ⚠ rules #2/#3
- **In-scope:** FeeCollector (V1/V2), OrderExecutor.
- **Attacker goals:** drain via reentrancy; bypass access control; forge/replay orders; skip
  minimumOutput; sweep to a non-owner; whitelist a hostile router/selector.
- **Must-verify:** access control on every state-changing fn; `nonReentrant` where value moves;
  EIP-712 domain/typehash/nonce correctness (no replay, no cross-chain replay — verify `chainId` in
  domain separator); router **whitelist + timelock**; function-selector allowlist; on-chain
  `minimumOutput`; sweep destination = owner only; fee math (0.1% applied exactly once, never doubled/
  skipped); ETH vs ERC-20 paths; Augustus/whitelist **verified on-chain** (`whitelistedRouters(addr)`).
- **Method & tools:** `forge test` (the real gate, must stay green); `forge coverage`; **Slither**
  (reentrancy, access, tx-origin, uninitialized); Foundry **invariant/fuzz** tests for fee-once and
  minOutput; `cast code`/storage on the deployed contracts to prove source == on-chain.
- **Negative-path:** unauthorized caller, replayed signature, wrong-chain signature, selector not in
  allowlist, router not whitelisted, minOutput violated, reentrant token — all must revert.
- **Exit:** 0C/0H on contracts; every value-moving path proven access-controlled + reentrancy-safe +
  fee-once; on-chain addresses match source.

### Wave 2 — Fund-flow integrity (the money invariant)  ⚠ rules #2/#3
- **In-scope:** swap build path (`api/swap`, `v1/swap`), FeeCollector routing, `calldata-recipient.ts`,
  `calldata-decoder.ts`, adapters' recipient/selector handling, `partner-fee-invariant.ts`.
- **Attacker goal:** make output land anywhere but the user; apply the fee twice or zero; sneak an
  unrecognized router/selector through.
- **Must-verify (the guarantee):** router whitelist ∧ selector allowlist ∧ recipient gating ∧ on-chain
  `minimumOutput` ∧ FeeCollector routing ∧ FEE_INCOMPATIBLE handling ∧ partner fees ⇒ **output always
  lands with the user, the 0.1% fee applies exactly once, unrecognized routers/selectors are refused.**
- **Method:** trace each of the 12 adapters' calldata through `validateCallDataRecipient`; unit + the
  `partner-fee-invariant` test; property-test "fee applied once" across sources; fuzz malformed calldata.
- **Negative-path:** calldata with recipient=attacker; double-fee calldata; selector swap; FeeCollector
  bypass; per-chain router mismatch — all refused.
- **Exit:** the money invariant holds on every source × both chains; negative paths refused.

### Wave 3 — Oracle & safety gates (do they HOLD, chain-aware?)  ⚠ rule #9
- **In-scope:** `chainlink.ts`, per-feed staleness, composed cbETH feed, `depeg-gate.ts`, `defillama.ts`,
  `sequencer-check.ts`, cross-quote/quorum, `price-gate.ts`, `price-monitor.ts`, `chainlink-feeds.ts`.
- **Attacker goal:** settle a swap on a stale/deviant/depegged price; exploit an L2 sequencer-down
  window; silently skip a gate on the Base path.
- **Must-verify:** every gate is **chain-aware**; no code path silently skips it; each **rejects**
  bad/stale/inconsistent input; per-feed heartbeat staleness; depeg (market-vs-ER) blocks; DefiLlama
  blocks swaps >$10k when unavailable; sequencer gate on both quote and swap-build paths; **feed
  ADDRESSES verified on-chain** (`description()`/`aggregator()`), never by name.
- **Method:** enumerate every gate call site; assert the same gate runs on chainId 1 AND 8453; fork-test
  stale/deviant/depeg/sequencer-down → must reject; on-chain-read each feed used.
- **Negative-path:** stale round, deviating cross-quote, depegged LST, sequencer answer=1/in-grace,
  DefiLlama down + >$10k — each must block.
- **Exit:** no gate skippable, none weakened, all chain-aware, all feed addresses on-chain-verified.

### Wave 4 — Chain-awareness sweep (the #1 historical defect)
- **In-scope:** everything multi-chain: registry, clients, adapter-urls, routers, activation, tokens,
  plus every file that reads a chain-scoped constant (RPC, etherscan, token/feed/spender, chainId).
- **Attacker goal:** get a Base path to use a mainnet client/feed/spender/token → mispriced or misrouted.
- **Must-verify:** no mainnet assumption (chainId 1, mainnet RPC/client, etherscan, mainnet
  token/feed/spender) on any path that also runs on Base; `"1" !== 1` coercion at JSON boundaries;
  `getRpcUrl`/`getPublicClientForChain` chain-aware everywhere; mainnet byte-identical preserved.
- **Method:** grep-and-trace every chain-scoped constant; cross-domain diff (fixed here, missed there);
  numeric-chainId coercion audit at every JSON boundary.
- **Exit:** zero chain-pinned residue on a Base-reachable path; byte-identical mainnet, test-pinned.

### Wave 5 — Signing-trust (no signature without a reviewed frozen payload)  ⚠
- **In-scope:** EIP-712 order create + cancel, Permit2, CoW order signing, swap tx, admin Bearer.
- **Attacker goal:** get a user (or the keeper) to sign a payload different from what was reviewed;
  replay a signature; forge admin auth.
- **Must-verify:** EVERY wallet signature path (tx OR EIP-712) shows a TeraSwap review of the **exact
  frozen payload** before signing (swap/create/cancel per 9R/9U/cancel-review — confirm none remain
  un-reviewed, incl. CoW order signing, permits, approvals); nonce prevents replay; domain pins chainId;
  admin Bearer = SHA-256 + `timingSafeEqual` (constant-time, server-only, not logged).
- **Method:** enumerate every `signTypedData`/`sendTransaction`/permit call; confirm a review gate on
  each; diff signed-vs-reviewed payload; constant-time-compare check on `verifyBearerToken`.
- **Exit:** no un-reviewed signature path; no replay; admin auth sound.

### Wave 6 — Backend / API (31 routes; the A1 surface)
- **In-scope:** all §2.5 routes + rate-limiter + validation + sanitize-error + Supabase RLS.
- **Attacker goal (A1):** bypass validation/authz/rate-limit; force error→HTML; leak a secret; read/
  write another user's rows; coerce chainId; thundering-herd the cache.
- **Must-verify per route:** input validation (address/amount/slippage/chainId); authz (admin routes
  Bearer-gated 401/503; `v1/*` mainnet-only rejects non-1); rate-limit runs before upstream + before
  budget burn; **errors return JSON never HTML**; no `NEXT_PUBLIC_` server secret; **Supabase RLS
  isolates users** (per-wallet rows unreadable/unwritable cross-user); timeouts cover **body parse** not
  just headers; single-flight on cache-miss; `telegram/webhook` verifies Telegram secret; numeric
  chainId coercion (`"1" !== 1`).
- **Method:** per-route request matrix (valid, malformed, oversized, wrong-method, missing-auth,
  wrong-chain, replayed); RLS red-team (craft a query for another wallet's rows); grep `NEXT_PUBLIC_`.
- **Negative-path battery:** unauth admin → 401/503; bad JSON → 400 JSON; oversized body → refused;
  non-1 to `v1/*` → refused; DefiLlama-down + >$10k swap → blocked; cross-user RLS → denied.
- **Exit:** every route validated, authz-correct, JSON-shaped, RLS-isolated, chain-coercion-safe.

### Wave 7 — Aggregation adapters (12 sources; the A2 surface)
- **In-scope:** the 12 source adapters + `shared.ts` + `recipient.ts` + `calldata-decoder.ts` +
  `partner-fee-invariant.ts` + `swap-build-retry.ts` + 9O fallback.
- **Attacker goal (A2):** a source returns hostile calldata that misroutes funds, inflates/zeros fee, or
  points at a non-whitelisted router/selector; a per-chain URL points a Base quote at mainnet.
- **Must-verify (each source):** calldata decoded + recipient gated + selector allow-listed + per-chain
  URLs correct + fee routing correct + partner fees + retry/fallback safe; unrecognized router/selector
  refused; no source can bypass the Wave-2 money invariant.
- **Method:** per-adapter calldata trace on both chains; hostile-fixture tests; confirm per-chain base
  URLs (Base ≠ mainnet); reconcile with the on-chain router whitelist.
- **Exit:** all 12 sources upheld the money invariant on both chains; hostile fixtures refused.

### Wave 8 — Keeper / order engine (A5 surface)
- **In-scope:** `executor.js`, `alert.js`, `freeze-score.js`, KMS/Vault signing, freeze flag, outflow
  detection, `circuit_breaker`, Worker cron.
- **Attacker goal (A5):** with a compromised keeper key, drain via executeOrder or direct tx; abuse the
  freeze flag; blind the observability; strand user funds during a freeze.
- **Must-verify:** keeper only signs the reviewed executeOrder payload; on-chain guards (recipient/
  minOutput/router) hold even if the keeper is hostile (so a key compromise can't misroute *via the
  contract*); **freeze = delay-not-loss** (no cancel/modify, funds/approvals untouched, resumes on
  unfreeze); **only the admin-authed endpoint writes the freeze flag** (no auto-freeze); fail-open reads
  vs `pause()` fail-safe split is correct; outflow detection threshold sane (own-gas subtracted);
  non-blocking observability; plaintext-key guard covers **both** chainId 1 and 8453; secrets never logged.
- **Method:** `node:test` re-run (not in CI); trace the freeze gate + writer; simulate KMS-hostile and
  confirm on-chain guards still bound the damage; verify `pause()` is the documented nuclear stop.
- **Exit:** delay-not-loss proven; single freeze writer; keeper compromise bounded by on-chain guards.

### Wave 9 — Wallet / frontend / session (A3 + UX-safety)
- **In-scope:** wagmi/RainbowKit/WalletConnect, `WalletSessionGuard`, COOP/COEP, secure storage,
  SwapBox/simulation/slippage/min-output, token catalog, review modals; ADR-008.
- **Attacker goal:** hijack a WC session; downgrade slippage/min-output; render a misleading review;
  leak session/secrets via storage; XSS into an alert/label.
- **Must-verify:** single `@walletconnect/core`, pinned `qr`; session lifecycle (idle disconnect, no
  double-init, clean teardown); COOP/COEP set; secure storage uses Web Crypto (no plaintext); min-output/
  slippage bounds enforced client AND server; review modal shows the true frozen payload; user-controlled
  strings escaped (token symbols → Telegram/DOM).
- **Method:** dependency de-dup check; session state machine review; render-path review for injection;
  reconcile slippage/min-output client vs server.
- **Exit:** session robust, storage safe, review truthful, min-output enforced both sides.

### Wave 10 — Supply chain / secrets / infra / CI (A6 surface)
- **In-scope:** root + executor sub-package lockfiles + `overrides`; `NEXT_PUBLIC_*`; headers/CSP/COOP;
  gitleaks; GitHub Actions (incl. blocking `test-contracts`); Vercel env scopes; Cloudflare Worker;
  Upstash/Supabase keys.
- **Attacker goal (A6):** poison a transitive dep to alter the build; exfiltrate a secret; weaken a CI
  gate; loosen headers.
- **Must-verify:** lockfile resolves a **single** instance of each critical dep (`@walletconnect/core`,
  `@coinbase/wallet-sdk`, `qr`, `viem`); no over-loose transitive range; `overrides` pin risky
  advisories; **no server secret behind `NEXT_PUBLIC_`**; secrets not logged / not in URLs that get
  logged; CI gates present and blocking (`test-contracts` not `continue-on-error`); gitleaks rules cover
  bare-hex; security headers sane; Worker cron authenticated to `monitor/tick`.
- **Method:** `npm ls` de-dup; `npm audit` triage → `overrides` plan; `git grep NEXT_PUBLIC_`; CI
  workflow read; header snapshot; secret-in-log grep.
- **Exit:** single-instance critical deps; zero `NEXT_PUBLIC_` secret; CI gates blocking; headers sane.

### Wave 11 — Synthesis, red-team chains & remediation plan
- **Objective:** dedupe + consolidate all wave findings; build **multi-step attack chains** that cross
  waves (e.g., A2 hostile calldata × a W4 chain-pinned recipient × a W6 weak validation); classify
  C/H/M/L/I; RICE-rank; write the master report + per-finding remediation prompts; update `AUDIT-TOTAL.md`.
- **Method:** cross-wave inconsistency hunt ("protection here, missing there"); attack-tree composition
  (§10); confirm no wave left a surface uncovered (§2 denominator = 100%).
- **Exit:** master report published; every C/H has a remediation prompt; coverage = 100% of §2.

---

## 6. Cross-cutting invariant register (must hold across ALL waves)

Every wave re-checks the invariants that touch its surface; Wave 11 confirms none is violated anywhere.

| # | Invariant | Primary owner | How to prove |
|---|-----------|---------------|--------------|
| INV-1 | **Fund custody:** swap output always lands with the user | W2/W1 | calldata recipient trace + on-chain minOutput |
| INV-2 | **Fee once:** 0.1% applied exactly once, never doubled/skipped | W2/W1 | partner-fee-invariant + property test |
| INV-3 | **Router/selector allowlist:** unrecognized refused | W2/W7/W1 | negative-path + on-chain `whitelistedRouters` |
| INV-4 | **Gate integrity:** no price/oracle/sequencer gate skippable or weakened | W3 | per-call-site chain-aware assert + fork reject |
| INV-5 | **Chain-awareness:** no mainnet residue on a Base path | W4 | grep-trace + cross-domain diff |
| INV-6 | **Signing-trust:** no signature without a reviewed frozen payload; no replay | W5 | enumerate signing paths + nonce/domain |
| INV-7 | **Authz:** admin/keeper/owner actions gated; RLS isolates users | W6/W8/W1 | request matrix + RLS red-team |
| INV-8 | **Fail-safe direction:** gates fail closed; advisory reads fail open by design | W3/W8 | trace each failure branch |
| INV-9 | **Delay-not-loss:** freeze/pause never cancels orders or strands funds | W8 | freeze gate trace + resume test |
| INV-10 | **Error-shape:** API errors return JSON, never HTML; secrets never logged | W6/W10 | per-route error test + log grep |
| INV-11 | **Supply-chain integrity:** single-instance critical deps; pinned risky ranges | W10 | `npm ls` + lockfile |
| INV-12 | **Mainnet byte-identical:** non-frozen, feature-off paths unchanged on mainnet | all | byte-identical test guard |

---

## 7. Adversarial methodology & orchestration

### 7.1 Sub-reviewer panels
For any C/H-capable surface (contracts, fund-flow, gates, signing), spin up **N independent
sub-reviewers** on the same locality with different adversarial framings (theft, replay, chain-confusion,
DoS). Reconcile: a finding stands only if it survives a second reviewer's refutation attempt; first-pass
noise is marked `REFUTED` with the reason.

### 7.2 On-chain verification playbook (decisive for addresses) — see Appendix A
Never trust a name. For every router/feed/spender/contract: `cast call <addr> "description()"` /
`"aggregator()"` / `whitelistedRouters(<router>)` / `cast code <addr>` on the correct chain RPC. Prove
source constant == on-chain reality.

### 7.3 Negative-path first
Each wave leads with the **attacker's** requests/inputs and asserts refusal, before confirming the happy
path. A protection is "verified" only when the malformed/stale/hostile input is demonstrably rejected.

### 7.4 Test re-execution
Re-run the owning suites in-session and record counts: `forge test` (contracts), `vitest` (app),
keeper `node --test` (not in CI — always re-run). Note environment caveats (sandbox arch) but treat CI
(linux-x64) as authoritative.

### 7.5 Tooling per wave
- Contracts: `forge test`/`coverage`/`invariant`, **Slither**, optional **Echidna**/Foundry-fuzz.
- App: `vitest`, `tsc --noEmit`, **semgrep** (taint: request→sink), `npm audit`, `npm ls` de-dup.
- Chain: `cast` (reads/forks), fork-tests for gate rejection.
- Secrets/CI: `gitleaks`, `git grep NEXT_PUBLIC_`, workflow YAML review.

### 7.6 Wave dependency graph (parallelization)
```
W0 ─┬─> W1 ─> W2 ─┐
    ├─> W3 ───────┤
    ├─> W4 ───────┼─> W11
    ├─> W5 ───────┤
    ├─> W6 ──> W7 ┤
    ├─> W8 ───────┤
    ├─> W9 ───────┤
    └─> W10 ──────┘
```
W1→W2 and W6→W7 are ordered (fund-flow depends on contract facts; adapters depend on route facts). The
rest run fully parallel after W0. W11 consumes all.

### 7.7 Per-wave packet (entry) & report (exit) format
- **Entry packet:** objective, in-scope file list, attacker goals, invariants to prove, tool plan.
- **Exit report:** checks-run table, findings table (Sev·`file:line`·disposition), negative-path
  results, coverage fraction of its §2 slice, verdict, remediation prompts. Lands in
  `Audits/Campaign/<date>/W<N>-<slug>.md`.

---

## 8. Deliverables & cadence

- **Per wave:** `Audits/Campaign/<date>/W<N>-*.md` + remediation prompts in `docs/Prompts/`.
- **Master:** `Audits/Campaign/<date>/MASTER-REPORT.md` (exec summary, C/H/M/L/I counts, RICE plan
  split "auto-fixable / needs contract sprint / needs human", coverage attestation = 100% of §2).
- **Ledger:** append the campaign verdict block to `docs/security/AUDIT-TOTAL.md`.
- **Cadence:** full campaign at each release/quarterly + on any contract/gate/fund-flow change; targeted
  single-wave re-run on every PR touching that wave's surface (LIGHT bar). Schedulable (daily health +
  weekly dep/audit already exist — this framework is the deep quarterly + change-triggered layer).
- **Boundaries:** stop at human-only steps (real-device wallet, live signatures, on-chain governance/
  `pause()`, deploys, secret rotation) — document, no loop.

---

## 9. Attack-scenario catalog — "todos os pontos de ataque" (master attack tree)

Organized by **attacker objective** (the root of each tree). Each leaf = a concrete scenario with its
owning wave and the invariant that must refute it. This is the completeness checklist: the campaign is
done when every leaf is exercised and refuted (or a finding is filed).

### G1 — Steal user funds (highest priority)
- G1.1 Hostile router calldata redirects output to attacker → recipient gating (W2/W7, INV-1).
- G1.2 minOutput not enforced on-chain → forced bad-price fill → on-chain minOutput (W1/W2, INV-1).
- G1.3 Fee applied twice or output net-negative → fee-once property (W2, INV-2).
- G1.4 Unwhitelisted router/selector accepted → allowlist refusal (W2/W7/W1, INV-3).
- G1.5 Reentrancy during ETH/ERC-20 settle → `nonReentrant` (W1).
- G1.6 FeeCollector sweep to non-owner → owner-only sweep (W1).
- G1.7 Permit2/approval scoped too broadly or to wrong spender → spender allowlist (W5/W2).
- G1.8 Order executed to a recipient ≠ owner → OrderExecutor recipient binding (W1/W8).

### G2 — Manipulate price / bypass a gate
- G2.1 Stale Chainlink round accepted → per-feed heartbeat staleness (W3, INV-4).
- G2.2 Deviant single-source price settles → cross-quote/quorum (W3, INV-4).
- G2.3 Depegged LST/stable settles → depeg-gate blocks (W3, INV-4).
- G2.4 DefiLlama down + large swap proceeds → >$10k block (W3, INV-4).
- G2.5 L2 sequencer-down/grace window fill → sequencer gate on quote AND swap-build (W3, INV-4).
- G2.6 Gate silently skipped on the Base path → chain-aware gate assert (W3/W4, INV-4/5).
- G2.7 Wrong feed address (name-trusted) → on-chain `description()`/`aggregator()` (W3, principle #2).

### G3 — MEV / sandwich
- G3.1 Public mempool sandwich → CoW/MEV-protection path + min-output (W9/W2).
- G3.2 Slippage/min-output downgraded client-side → server-side enforcement (W6/W9, INV-1).

### G4 — Forge / replay signatures
- G4.1 EIP-712 order replay (same chain) → nonce (W1/W5, INV-6).
- G4.2 Cross-chain order replay → chainId in domain separator (W1/W5, INV-6).
- G4.3 Un-reviewed payload signed (swap/create/cancel/CoW/permit) → review-gate on every signing path (W5, INV-6).
- G4.4 Forged admin Bearer → constant-time SHA-256 compare (W5/W6, INV-7).

### G5 — Chain confusion (Base ↔ mainnet)
- G5.1 Base path uses mainnet RPC/client → chain-aware clients (W4, INV-5).
- G5.2 Base path uses mainnet token/feed/spender → chain-scoped constants (W4, INV-5).
- G5.3 `"1" !== 1` chainId coercion at a JSON boundary → numeric coercion audit (W4/W6).
- G5.4 Swap built for a chain without a live FeeCollector → activation gate (W4/W6).

### G6 — Denial of service / liveness
- G6.1 Rate-limit bypass / flood → limiter before upstream + budget (W6).
- G6.2 Thundering-herd on cache-miss → single-flight (W6).
- G6.3 Freeze weaponized as DoS or freeze strands funds → delay-not-loss + single writer (W8, INV-9).
- G6.4 Sequencer-window forced execution → sequencer gate (W3).
- G6.5 API error returns HTML page (breaks client) → JSON error-shape (W6, INV-10).

### G7 — Privilege escalation
- G7.1 Contract owner-only fn callable by others → access control (W1, INV-7).
- G7.2 Admin route (kill-switch/api-keys/freeze) reachable without Bearer → authz (W6/W8, INV-7).
- G7.3 Keeper/score/alert writes the freeze flag → single admin writer (W8, INV-7/9).
- G7.4 Telegram webhook accepts unauthenticated commands → webhook secret (W6).

### G8 — Supply chain / build integrity
- G8.1 Duplicate/loose critical dep alters build → single-instance + pins (W10, INV-11).
- G8.2 Transitive advisory (form-data/undici/hono/vite/ws) unpatched → `overrides` plan (W10).
- G8.3 CI gate `test-contracts` made non-blocking → gate-present check (W10).

### G9 — Secret exfiltration / info disclosure
- G9.1 Server secret behind `NEXT_PUBLIC_` → env-scope scan (W10, INV-10).
- G9.2 Secret logged (Bearer/bot token/KMS) or in a logged URL → log grep (W8/W10, INV-10).
- G9.3 RLS bypass reads another user's rows → RLS red-team (W6, INV-7).
- G9.4 Error stack/HTML leaks internals → sanitize-error (W6, INV-10).

### G10 — Data / state integrity
- G10.1 Nonce reuse double-executes an order → nonce (W1/W8, INV-6).
- G10.2 Order status race (lock/unlock) strands or double-runs → atomic lock (W8).
- G10.3 Analytics/log endpoints accept forged attribution → input validation (W6).

> **Completeness rule:** the campaign is COMPLETE only when every G-leaf above is either exercised-and-
> refuted (with evidence) or has a filed finding + remediation prompt. Wave 11 attests this and maps
> §2 coverage to 100%.

---

## Appendix A — On-chain verification playbook (`cast`)
Run against the correct chain RPC (mainnet vs Base). Examples (fill live addresses at campaign time):
- Feed identity: `cast call <FEED> "description()(string)"` · `cast call <FEED> "aggregator()(address)"`.
- Feed freshness: `cast call <FEED> "latestRoundData()(uint80,int256,uint256,uint256,uint80)"` → check
  `updatedAt` vs heartbeat×1.5; `answeredInRound >= roundId`.
- Router whitelist: `cast call <ORDER_EXECUTOR> "whitelistedRouters(address)(bool)" <ROUTER>`.
- Sequencer feed: `cast call <SEQ_FEED> "latestRoundData()..."` → answer 0=up/1=down + grace since `startedAt`.
- Contract identity: `cast code <ADDR>` (keccak vs source build) to prove source == deployed.
- Owner/spender: `cast call <FEECOLLECTOR> "owner()(address)"`, Permit2 spender allowlist reads.

## Appendix B — Per-wave quick checklists
Condensed from §5 "Must-verify" — one check row per invariant, ticked with `file:line` + evidence.
(W1 access/reentrancy/nonce/selector/minOutput/sweep/fee; W2 recipient/fee-once/allowlist; W3
staleness/depeg/defillama/sequencer/chain-aware/on-chain-feed; W4 client/constant/coercion/activation;
W5 every-signing-path/nonce/domain/bearer; W6 per-route validation/authz/ratelimit/JSON/RLS/coercion; W7
per-adapter calldata/recipient/selector/URL/fee; W8 freeze-delay-not-loss/single-writer/KMS-bounded/
outflow; W9 WC-single-core/session/storage/min-output; W10 dep-dedup/NEXT_PUBLIC/CI-gate/headers.)

## Appendix C — Invariant → test → on-chain-read map
For each INV-1..12: the owning test file(s) to re-run, the negative-path case that proves it, and the
`cast` read (if address-dependent). Maintained alongside the code so a moved gate updates its row.

## Appendix D — Tooling matrix
`forge` (test/coverage/invariant), **Slither**, Foundry-fuzz/**Echidna** (contracts); `vitest`,
`tsc`, **semgrep** taint rules, `npm audit`, `npm ls` (app/deps); `cast` + fork (chain); `gitleaks`,
`git grep`, workflow review (secrets/CI). Each wave declares which it ran and the result.

---

### Changelog
- v1 (2026-06 campaign) — initial framework: 12 waves, 12 invariants, 10-objective attack catalog,
  grounded in the current 31-route / 3-contract / 12-adapter / multi-gate surface.
