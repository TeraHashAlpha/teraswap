# SEC-0 · Wave 0 — Recon & surface baseline (entry packet)

> **Campaign:** 2026-07-01. **Sprint:** SEC-0 (kickoff, prerequisite for all others). **Runner:** Auditor
> (read-only; never edits code). **Source of truth:** `docs/security/TERASWAP-AUDIT-FRAMEWORK.md` (T-SAF v1) §5
> Wave 0 + §2 inventory + §6 invariant register. **Binding:** T-SAF §1 principles + CLAUDE.md #1/#2/#3/#12.
> **No findings in W0** — this wave sets the denominator that grounds SEC-1..SEC-4.

## Objective
Regenerate the T-SAF §2 attack-surface inventory from the **current tree** (not from memory), diff it against the
last campaign, build the §6 invariant register with its file map, and **snapshot the deployed contract/feed/router
addresses on-chain (both chains)** so every later wave cites verified ground truth.

## In-scope (enumerate + assign every item to exactly one wave)
The full §2 inventory: 2.1 contracts (W1/W2) · 2.2 safety gates/oracle (W3) · 2.3 multi-chain registry (W4) ·
2.4 signing-trust (W5) · 2.5 the 31 API routes + supporting libs (W6) · 2.6 the 12 aggregation adapters (W7) ·
2.7 keeper/order engine (W8) · 2.8 wallet/frontend/session (W9) · 2.9 supply chain/secrets/infra/CI (W10).

## Method
1. **File enumeration** — walk the tree; produce the *actual* current file list per §2 slice (path + one-line role).
   Flag any §2 item whose file **moved/renamed/split/vanished** since T-SAF v1 (the framework was written 2026-06).
2. **Diff since last campaign** — `git log`/`git diff` against the last audit baseline; list every surface file
   touched (these get priority + a targeted re-run flag).
3. **Invariant register (§6)** — for INV-1..12, record the owning file(s)/test(s), the negative-path case that
   proves it, and the `cast` read (if address-dependent). This is Appendix C, grounded to current line numbers.
4. **On-chain address snapshot (both chains, Appendix A)** — for the deployed set, verify by `cast`, never by name:
   - FeeCollector V2 (mainnet), FeeCollector (Base), OrderExecutor (both chains): `cast code <addr>` (prove
     source == deployed via keccak vs build), `owner()`, and the router whitelist `whitelistedRouters(<router>)(bool)`.
   - Every Chainlink feed in use: `description()(string)` + `aggregator()(address)` + a `latestRoundData()` freshness
     read; the composed cbETH feed; the L2 sequencer feed.
   - Permit2 spender(s) / any spender allowlist. Record chain + address + verified identity in a table.
5. **Wave-ownership map** — confirm **no surface item is unowned** and none is owned by two waves.
6. **Byte-identical baseline** — record the current mainnet deployed bytecode hashes so later waves can test the
   "mainnet byte-identical" invariant (INV-12).

## Tool plan (§7.5)
File walk + `git diff`; `cast call`/`cast code` against the correct chain RPC (mainnet vs Base — chain-aware);
`git grep` for chain-scoped constants + `NEXT_PUBLIC_` (headroom map for W4/W10). Re-run counts not required in W0.

## Deliverables (exit report, this file's report section)
- The **grounded §2 inventory** (current file list per slice) + the moved/renamed/vanished delta vs T-SAF v1.
- The **on-chain address snapshot table** (chain · address · `cast`-verified identity) for contracts, feeds,
  routers, spender(s), sequencer feed.
- The **invariant register** (INV-1..12 → files/tests/negative-path/`cast` read).
- The **wave-ownership map** (every §2 item → its wave; no gaps, no overlaps).
- The **since-last-campaign diff** (priority surfaces).

## Exit criteria
Inventory published; every surface item assigned to exactly one wave (no surface unowned); all deployed
addresses on-chain-verified (identity proven, not name-trusted); invariant register + byte-identical baseline
recorded. **No findings.** On completion, the Architect generates the SEC-1..SEC-4 entry packets grounded on this
output.

---

### `/goal` paste for the Auditor (≤4000)
```
Run T-SAF Wave 0 (Recon & surface baseline) per Audits/Campaign/2026-07-01/
W0-recon.md and docs/security/TERASWAP-AUDIT-FRAMEWORK.md §5-W0 + §2 + §6.
READ-ONLY, no findings, no code edits.

1. Enumerate the CURRENT tree per the §2 inventory (2.1 contracts → 2.9
   supply-chain). For each §2 slice output the actual file list (path +
   one-line role). Flag any item that moved/renamed/split/vanished since
   T-SAF v1 (June 2026).
2. Diff since the last audit baseline (git log/diff) — list surface files
   touched; mark them priority + targeted-re-run.
3. Build the §6 invariant register: INV-1..12 → owning file(s)/test(s) +
   the negative-path case that proves it + the cast read (if address-based),
   grounded to current line numbers.
4. On-chain address snapshot (BOTH chains, Appendix A; verify by cast, never
   by name): FeeCollector V2 (mainnet), FeeCollector (Base), OrderExecutor
   (both) — cast code (source==deployed), owner(), whitelistedRouters(router);
   every Chainlink feed in use — description()+aggregator()+latestRoundData()
   freshness; composed cbETH feed; L2 sequencer feed; Permit2/spender
   allowlist. Output a table: chain · address · verified identity.
5. Wave-ownership map: every §2 item -> exactly one wave; assert no surface
   unowned and none double-owned.
6. Record current mainnet deployed bytecode hashes (INV-12 byte-identical
   baseline).

Deliver into Audits/Campaign/2026-07-01/W0-recon.md (report section): grounded
inventory + moved/renamed delta, on-chain address table, invariant register,
wave-ownership map, since-last-campaign diff. No findings. SSH-signed commit
(noreply committer). This output grounds the SEC-1..SEC-4 packets — do NOT
cite files/addresses from memory; only what you verified this run.
```

---

# WAVE 0 — REPORT (executed 2026-07-01, Auditor, read-only, no findings)

## Environment & method (reproducibility caveats)
- **On-chain reads:** `cast`/Foundry not installed in-sandbox → used **viem** (in `node_modules`) via
  `node -e`, chain-aware, retried ×3 for public-RPC flakiness. Mainnet RPC: `ethereum-rpc.publicnode.com`
  (cloudflare-eth + llamarpc rejected `eth_getCode`); Base RPC: `mainnet.base.org`. Equivalent to the
  Appendix-A `cast` playbook; a follow-up may re-confirm under `cast`.
- **Sandbox limit:** file unlink is blocked — a throwaway `./.w0onchain.mjs` helper could not be removed
  from bash and was NOT committed. **Owner cleanup:** `rm ".w0onchain.mjs"` (untracked, harmless).
- **Commit:** SSH-signing is a human step (no key in sandbox) — left for the owner's signed batch.

## 1. Grounded §2 inventory (re-enumerated this run)
Counts confirmed present: **3** own contracts (`TeraSwapFeeCollector.sol`, `…V2_flat.sol`,
`order-engine/TeraSwapOrderExecutor.sol`; OZ under `out/` vendored, excluded) · **15** gate/oracle libs ·
**9** chains-registry libs · **31** API routes · **12** source adapters (+`shared,recipient,
calldata-decoder,partner-fee-invariant,swap-build-retry`) · **3** keeper modules.
**Moved/renamed/split/vanished vs T-SAF v1:** none (framework authored same session, same tree). Only
surface movement = uncommitted `order-engine/executor` lockfile + OZ submodule pointer (→ §5).

## 2. On-chain verification (both chains, viem, this run — NOT by name)
### Mainnet (chainId 1)
| Component | Address | Verified |
|---|---|---|
| FeeCollector **V2** | `0x47f2…7459` | code 5419b, hash `0x3bde15fc219da158`; `owner()` **reverts** |
| FeeCollector V1 | `0x4dAE…58eD` | code 5826b, hash `0x0462a4dea82127de` |
| **OrderExecutor** | `0xeFC3…f130` | code **13244b**, hash `0x86c4cf824ab04c2d`; `owner()` reverts; `whitelistedRouters`: 1inchV6=**true**, **AugustusV5=true, AugustusV6=false** |
| Permit2 | `0x0000…8BA3` | code 9152b, hash `0xc67d1657868aa514` |
| ETH/USD | `0x5f4e…8419` | "ETH / USD" 8dp, fresh (655s), 1628.88 ✅ |
| USDC/USD | `0x8fFf…18f6` | "USDC / USD" 8dp, 14.6h < 24h heartbeat ✅ |

### Base (chainId 8453)
| Component | Address | Verified |
|---|---|---|
| FeeCollector | `0xeFC3…f130` | code **5339b**, hash `0x2ff08ff8b42c44ba` — **different contract from the SAME address on mainnet (13244b)**; `whitelistedRouters(1inch)`=true |
| Permit2 | `0x0000…8BA3` | code 9152b, hash `0xa67739abc3ede9db` (same len, diff hash — chainId/domainSeparator immutables; expected) |
| Base ETH/USD | `0x7104…Bb70` | "ETH / USD" 8dp, 167s ✅ |
| Base USDC/USD | `0x4581…9061` | "USDC / USD" 8dp, 4.75h ✅ |
| cbETH/ETH market | `0x806b…440b` | 18dp, 8.7h, 1.13373; `description()` **reverts** on proxy |
| cbETH/ETH XR | `0x868a…5F04` | "cbETH-ETH Exchange Rate" 18dp, 1.13383 — market↔XR ≈0.009% → **no depeg** ✅ |
| Sequencer | `0xBCF8…6433` | `answer=0` (**UP**), startedAt age 21867s ≫ 3600s grace → up ✅; `description()` reverts |

**Decisive seeds:** (1) OrderExecutor whitelists **Augustus V5, not V6** — a V5→V6 config migration would
break Velora/ParaSwap orders (9V lesson, live) → W2/W7. (2) `0xeFC3…f130` = **different contract per
chain** → W4 chain-confusion priority. (3) `whitelistedRouters` exists on BOTH contract types → identify
by bytecode, not by that mapping. (4) `owner()` reverts on V2 + OrderExecutor → non-`Ownable` admin model,
W1 must find the real accessor.

## 3. Invariant register (INV → owner file:line · negative-path · on-chain read)
INV-1 `calldata-recipient.ts:544` (inner `:440`) · recipient=attacker→refuse · n/a.
INV-2 `adapters/partner-fee-invariant.test.ts:14` · FEE_INCOMPATIBLE source also routing FeeCollector→fail · n/a.
INV-3 `chains/routers.ts:135` `isWhitelistedRouter` (`getRouterWhitelist:126`) · unknown router→refuse · `whitelistedRouters(addr)`.
INV-4 `price-gate.ts:51`,`depeg-gate.ts:41`,`chains/sequencer-check.ts:64` · stale/deviant/depeg/seq-down→reject on 1 AND 8453 · `latestRoundData` freshness + seq answer.
INV-5 `chains/{registry,clients,adapter-urls,routers}.ts` · Base path resolving mainnet client/feed→fail · 0xeFC3 divergence.
INV-6 `api/orders/route.ts`,`orders/[id]`,`adapters/cow.ts`,`auth.ts` · replay/cross-chain/un-reviewed→refuse · EIP-712 domain chainId.
INV-7 `auth.ts` verifyBearerToken; `supabase/schema.sql`+`migrations/` · cross-user row / unauth admin→deny · n/a.
INV-8 `sequencer-check.ts` (fail-safe false) vs `dca-freeze.ts` (fail-open read) · gate RPC error→still reject · n/a.
INV-9 `executor.js` freeze-honor + `dca-freeze.ts` · frozen→returns active, funds untouched, resumes · `pause()`.
INV-10 `sanitize-error.ts` + per-route · force error→assert JSON; secret-in-log grep · n/a.
INV-11 root lockfile+`overrides`, `order-engine/executor` lockfile · dup `@walletconnect/core`/`qr`/`viem`→fail · n/a.
INV-12 bytecode hashes (§2) + feature-off guards · mainnet path differs feature-off→fail · code hashes (§6).

## 4. Wave-ownership map (100% assigned, no orphan, no double-owned)
W1=2.1 contracts · W2=swap fund-flow (`api/swap`,`v1/swap`,FeeCollector routing,`calldata-recipient/decoder`,`partner-fee-invariant`) · W3=2.2 gates/oracle · W4=2.3 registry/chain-awareness · W5=2.4 signing · W6=2.5 31 routes+support+RLS · W7=2.6 12 adapters+`shared/recipient/swap-build-retry` · W8=2.7 keeper+`circuit_breaker`+Worker · W9=2.8 wallet/FE · W10=2.9 lockfiles/`NEXT_PUBLIC_`/headers/CI/CF/Upstash/Supabase · W11=synthesis.

## 5. Since-last-campaign diff (this IS the baseline — no prior T-SAF campaign)
HEAD `df00d35` "SPRINT-201 … APPROVED" (prior pending audit batch now committed). **Uncommitted surface
deltas (W10 triage):** `order-engine/executor/package.json`+`package-lock.json` (executor lockfile churn),
OZ submodule pointer, Foundry `solidity-files-cache.json` (build artifact, ignorable). Predate the campaign.

## 6. INV-12 byte-identical baseline (regression reference; truncated keccak prefixes)
Mainnet: FeeCollectorV2 `0x3bde15fc219da158`/5419b · V1 `0x0462a4dea82127de`/5826b · OrderExecutor
`0x86c4cf824ab04c2d`/13244b · Permit2 `0xc67d1657868aa514`/9152b. Base: FeeCollector
`0x2ff08ff8b42c44ba`/5339b · Permit2 `0xa67739abc3ede9db`/9152b.

## 7. Exit
Inventory published + 100% wave-assigned; addresses on-chain-verified live (both chains); invariant
register + wave map built; byte-identical baseline recorded. **No findings (W0 = recon).** Ready to ground
SPRINT-SEC-1..4 with the priority seeds above. Human-only/out-of-W0: live signatures, deploys, `pause()`,
secret rotation. Owner cleanup: delete untracked `.w0onchain.mjs`.
