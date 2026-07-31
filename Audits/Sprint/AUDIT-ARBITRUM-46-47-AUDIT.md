# AUDIT-ARBITRUM-46-47 — joint activation gate (Sprint 46 #300 merged + Sprint 47 #303)

## VERDICT: 🔴 BLOCK — #303 must NOT merge as an activation-prep gate, and the owner must NOT execute `ARBITRUM-FEECOLLECTOR-DEPLOY.md`.

**3 HIGH.** Nine core `CHAIN_CONFIGS[42161]` addresses — 3 tokens (USDT, DAI, WBTC), the L2 **sequencer uptime
feed**, and **all 5 Chainlink price feeds** — point at contracts with **ZERO code on Arbitrum One**, verified
this audit on two independent chainId-`0xa4b1` RPCs (raw `eth_getCode` + `eth_call latestRoundData`, block
~482,185,903, 2026-07-09T22:53Z), with WETH/USDC and the *true* Arbitrum USDT/DAI as working controls. #303
re-verified only the **routers/adapters** (Part 1b — those are all correct); it left the Sprint-46
recon-sourced **tokens, feeds, and sequencer feed** (Part 1a) unverified, and they are dead. The recon's
"on-chain verified during recon" claim for those is false — the same untrusted-recon failure mode #303 existed
to close, still open for the non-router addresses. At activation this ships a dead-on-arrival chain (the dead
sequencer feed makes the fail-closed sequencer gate refuse **every** Arbitrum quote/swap; dead feeds knock out
the value/fee-USD oracle; USDT/DAI/WBTC map to non-contracts). No fund-drain (all paths fail closed), but rule
#3 (no deploy without on-chain address verification) and the "never approve an unverified/dead on-chain
address" Do-NOT are dispositive → BLOCK.

Audited SHA `0d9cdb7` (`sprint/47-arbitrum-activation-prep`, 4 commits, all SSH-signed), base `origin/main`
`4277e15`. Sandbox: `cast`/`forge` absent → viem + raw JSON-RPC. **The recon report was treated as untrusted;
every address below was read on-chain independently.**

---

## Part 1 — 42161 on-chain address-sweep manifest (audit-grade)

`eth_getCode` at `latest`, both `arbitrum-one-rpc.publicnode.com` and `arb1.arbitrum.io/rpc` (chainId 0xa4b1).
Dead feeds/sequencer additionally probed with `eth_call latestRoundData()` (all returned `0x`, i.e. no
contract). Controls: WETH + USDC(native) → code; true Arbitrum USDT/DAI → code — the read path is sound.

### ✅ LIVE + correct (keep)
| Address | Role | Check | Verdict |
|---|---|---|---|
| `0x82aF49…fBab1` | WETH | code 2092 B, `symbol=WETH decimals=18` | ✅ |
| `0xaf88d0…5831` | USDC (native) | code 1852 B, `symbol=USDC decimals=6` | ✅ (native, not USDC.e — correct) |
| `0x000000…78BA3` | Permit2 | code 9152 B | ✅ |
| `0xC92E8b…E0110` | CoW VaultRelayer | code 4590 B | ✅ |
| `0x111111…42A65` | 1inch AggRouterV6 | code | ✅ (#303 re-verified) |
| `0x000000…22734` | 0x AllowanceHolder | code 1009 B | ✅ |
| `0x6131B5…37b5` | KyberSwap | code | ✅ |
| `0x6352a5…04e64` | OpenOcean | code | ✅ (#303: live POST returned this tx.to) |
| `0xAC4c6e…80b75` | Sushi RedSnwapper | code 4978 B | ✅ (#303 corrected from dead RP5) |
| `0xBA1222…BF2C8` | Balancer Vault | code | ✅ (globally disabled — inert) |
| `0x68b346…65Fc45` | Uniswap SwapRouter02 | code 24,497 B | ✅ (#303 corrected from V1 SwapRouter) |
| `0x61fFE0…30B21e` | Uniswap QuoterV2 | code 8273 B | ✅ (#303 corrected) |
| `0x1F9843…31F984` | Uniswap V3 Factory | code 24,535 B | ✅ (#303 corrected from a typo'd dead addr) |
| `0x6A000F…001068` | **Augustus V6.2 (FeeCollector whitelist candidate)** | code 24,562 B | ✅ EXACT, matches Base/mainnet |
| `0x19cEeA…6095a1` | whitelist entry (runbook Step 4) | code 20,290 B | ✅ live (confirm identity vs report) |

### 🔴 DEAD — zero code on Arbitrum (BLOCKERS)
| Address | Claimed role | On-chain | True Arbitrum addr (candidate — owner MUST re-verify, do not paste blindly) |
|---|---|---|---|
| `0xFd086b2F39B6b86fEe29f27E8f6be40e7F2E7D2b` | USDT token | **EMPTY** | `0xFd086bC7Cd5C481DCC9C85ebE478A1C0b69FCbb9` (has code) |
| `0xda10009754f1dF9137293aed5d6DD0dB0Bb075e9` | DAI token | **EMPTY** | `0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1` (has code) |
| `0x2F2a2440D2f12C0cDdE18Fe9AEf0cc0d6cF3FC30` | WBTC token | **EMPTY** | — (re-verify) |
| `0xFdB631f5eE196f5C5AA41F952B0282f59B2Eff9E` | **Sequencer uptime feed** | **EMPTY** (getCode 0 + latestRoundData `0x`) | — (re-verify canonical Arbitrum sequencer feed) |
| `0x639Fe6ab55C921f74e7fac19EEcf32fd97d80027` | ETH/USD feed | **EMPTY** | — (re-verify) |
| `0x50834F3e0744f40f628f86e6388f2a4f9a81147f` | USDC/USD feed | **EMPTY** | — |
| `0xc5C8E77B397E3A2B92f72841640bc7F7eF440DA7` | DAI/USD feed | **EMPTY** | — |
| `0x3f3f5dF88dC9F13eAFAa42Efb9A3c236f4B3E305` | USDT/USD feed | **EMPTY** | — |
| `0xd0C7101eACbB49F3Debb3C340BB2F48c36e341c5` | WBTC/USD feed | **EMPTY** | — |

*(I deliberately supply only the two token candidates I could positively confirm on-chain as controls; per the
"never invent addresses" rule the owner must independently re-recon all 9 — do not trust this table's right
column as the fix.)*

### ✅ #303 router corrections independently validated (recon values ARE dead)
`0xE592427A…` (recon "SwapRouter02") = the **V1** SwapRouter (live, but wrong contract/calldata shape — correct
to exclude); `0x54F0fF…` (recon Sushi RP5), `0xb27308…` (recon quoter), `0x1f98431C…ea31564E` (recon factory
typo) all **EMPTY** — confirming #303's corrections. `0xf0d4C1…e854` (Curve) EMPTY but **inert** (curve adapter
is mainnet-only fail-closed; flagged-not-guessed — acceptable).

---

## Part 2 — activation plumbing (reviewed; sound where reached)
- **Null-default dark:** `contracts.feeCollector = process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR || null`
  (`|| null`, not `??`, so `=""` stays dark); `isChainActive(42161)` gates on `feeCollector !== null` →
  "coming-soon" while unset. ✅ Regression-guarded posture correct.
- **clients.ts:** `VIEM_CHAINS[42161] = arbitrum` present. ✅ (the broader "silent-chain-object-loss class"
  probe across other registries was NOT completed — see re-audit scope; not the blocker.)
- **Regression guard (`0d9cdb7`):** pins ONLY `uniswapv3`/`sushiswap`/Augustus + a 12-key router count — it does
  **NOT** cover the tokens, feeds, or sequencer feed, so the 9 dead addresses are both wrong AND unguarded, and
  the guard gives false "addresses verified" confidence. **Extend it to pin the corrected token/feed/sequencer
  set once re-verified** (part of the fix).
- Order-engine isolation under the activated state (executor null / isDcaLive pinned 8453 / no keeper pickup)
  was NOT re-audited this pass — moot until Part 1 is fixed and re-submitted.

## Part 3 — runbook (reviewed; not the blocker, but note)
- FeeCollector V2: **no `.sol` changes in #303** — deploys the audited Base/mainnet source, no drift. ✅
- Whitelist = input-and-checked (`bootstrapRouters` once; §5 `cast call whitelistedRouters` incl. a negative
  check that the old V1 SwapRouter is NOT whitelisted). Augustus V6.2 whitelist input verified live above. ✅
- The runbook's Step-1 "re-verify on-chain, labels lie" discipline is right — but it was applied to routers,
  **not** to the token/feed/sequencer set the runbook itself depends on (fee-USD, sequencer gate). **The
  activation checklist must add an explicit on-chain re-verification of every token + every Chainlink feed +
  the sequencer feed, exactly as it does for routers**, before any Preview flip.

---

## Findings

- **H-01 · `registry.ts` (ARBITRUM.sequencerUptimeFeed `0xFdB631…Eff9E`) · dead.** The sequencer gate
  (`sequencer-check.ts`, fail-safe→`false` on read error) reads a non-contract → every Arbitrum `/api/quote`
  and `/api/swap` refuses (503) at activation. Fail-closed (no drain) but the chain is dead-on-arrival and a
  safety-gate address is invalid. Re-verify the canonical Arbitrum sequencer-uptime feed on-chain.
- **H-02 · `chainlink-feeds.ts[42161]` (all 5 feeds) · dead.** The fee-USD / >$10k value-gate oracle has no
  working Chainlink leg on Arbitrum; every `latestRoundData` reverts. Re-verify all 5 feeds (fresh round,
  8-dec, `description()` matches pair).
- **H-03 · `registry.ts` ARBITRUM.tokens (USDT/DAI/WBTC) · dead.** 3 of 5 offered tokens map to non-contracts —
  quotes/approvals/swaps against them revert; users could approve a dead address. Re-verify the canonical
  Arbitrum token addresses (USDC native + WETH already correct).
- **M-01 · regression guard coverage gap.** `0d9cdb7` pins routers only; add token/feed/sequencer pins after
  correction so a silent revert to recon values fails CI (the stated goal, currently unmet for 9 addresses).

## Remediation prompt (Code-Agent-ready) — SPRINT-47 follow-up (fund/gate → re-audit before merge)

**Context:** independent on-chain verification (this audit) found 9 dead `CHAIN_CONFIGS[42161]` addresses —
USDT/DAI/WBTC tokens, the sequencer uptime feed, and all 5 Chainlink feeds — that #303 did not re-verify.
**Objective:** re-recon EVERY non-router Arbitrum address on-chain and correct the config, matching the rigor
#303 applied to routers. **Requirements:** for each token, read `symbol()`/`decimals()` on Arbitrum and confirm
the pair; for each Chainlink feed, confirm code + `decimals()==8` + `description()` matches the claimed pair +
a fresh `latestRoundData` round; for the sequencer feed, confirm it answers `latestRoundData` (0=up); record
method+result per address in `ARBITRUM-ROUTER-VERIFICATION.md` (rename to cover all classes). Correct
`registry.ts` (tokens, sequencerUptimeFeed) and `chainlink-feeds.ts[42161]`. Extend the regression guard to pin
every corrected address (revert-to-recon fails CI). **Do NOT:** invent an address — flag-not-guess any you
cannot positively verify (as #303 did for Curve); do not flip any env. **Files:** `src/lib/chains/registry.ts`,
`src/lib/chains/chainlink-feeds.ts`, the regression test, `docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md`.
**Tests:** the guard fails if any address reverts to a recon/dead value. **Quality:** every 42161 address
resolves to live code with the expected semantics; re-submit for a fresh Auditor pass before merge/activation.

_What #303 got RIGHT (keep): all router/adapter corrections (verified live on-chain), Augustus V6.2 whitelist
candidate (live, exact), the null-default dark posture, FeeCollector no-drift, the input-and-checked whitelist
discipline. The fix is scoped to the 9 non-router addresses + the guard._

_Read-only; no source edited. Report + AUDIT-TOTAL block left for the owner's SSH-signed batch (rule #12)._
