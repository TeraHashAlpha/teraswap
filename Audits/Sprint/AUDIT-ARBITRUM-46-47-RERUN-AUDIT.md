# AUDIT-ARBITRUM-46-47 (RE-RUN @ 2f9f376, post CHORE-47B) — activation joint gate

## VERDICT: ✅ APPROVE-TO-MERGE (0C / 0H) — prior BLOCK fully remediated.
#303 may merge and the owner may execute `ARBITRUM-FEECOLLECTOR-DEPLOY.md`. **One MEDIUM runbook amendment
(empty token catalog) must be applied before the Preview smoke can pass — it is fail-safe (the Preview gate
blocks a broken prod flip regardless), so it does not block the 0C/0H authorization, but the activation cannot
*succeed* without it.**

Audited SHA `2f9f376` (`sprint/47-arbitrum-activation-prep`, CHORE-47B on top of SPRINT-47; 10 commits since
base, all SSH-signed), rebased on `main` (includes merged #302 + my prior V3 amendments). Sandbox: `cast`/`forge`
absent → viem + raw JSON-RPC. **The manifest, ARBITRUM-READINESS.md and ARBITRUM-ADDRESS-VERIFICATION.md were
treated as claims; I re-read all 24 addresses on-chain independently** (2 chainId-`0xa4b1` RPCs, arb block
~482,322,287, 2026-07-10T08:20Z).

---

## Part 1 — independent FULL 24-address sweep (prior 3 HIGH → CLOSED)

Every address now has code on **both** RPCs with correct semantics. The prior dead set (3 tokens, sequencer,
all 5 feeds) is corrected; the 5 feeds are **live AND fresh** (I decoded `latestRoundData`, not just code).

| # | Role | Address | On-chain check | Verdict |
|---|---|---|---|---|
| 1 | WETH | `0x82aF49…fBab1` | `symbol=WETH decimals=18` | ✅ |
| 2 | USDC (native) | `0xaf88d0…5831` | `symbol=USDC decimals=6` | ✅ not USDC.e |
| 3 | USDT | `0xFd086bC7…FCbb9` | `symbol="USD₮0" decimals=6` | ✅ (USDT0 — see Part 2) |
| 4 | DAI | `0xDA10009c…000da1` | `symbol=DAI decimals=18` | ✅ (corrected) |
| 5 | WBTC | `0x2f2a2543…C5B0f` | `symbol=WBTC decimals=8` | ✅ (corrected — new addr) |
| 6 | ETH/USD feed | `0x639Fe6ab…ba612` | dec=8, `"ETH / USD"`, answer $1774.81, age 249s | ✅ fresh |
| 7 | USDC/USD feed | `0x50834F31…34aD3` | dec=8, `"USDC / USD"`, ~$1.000, age 190s | ✅ fresh |
| 8 | DAI/USD feed | `0xc5C8E77B…9eCfB` | dec=8, `"DAI / USD"`, ~$0.9997, age ~11.6h (<24h heartbeat) | ✅ fresh |
| 9 | USDT/USD feed | `0x3f3f5dF8…5DdE7` | dec=8, `"USDT / USD"`, ~$0.9993, age 44s | ✅ fresh |
| 10 | WBTC/USD feed | `0xd0C7101e…6D46d57` | dec=8, `"WBTC / USD"`, ~$63,918, age 526s | ✅ fresh |
| 11 | Sequencer uptime | `0xFdB631F5…697D` | `answer=0` (UP), up ~50d, past grace | ✅ |
| 12 | Permit2 | `0x000000…78BA3` | code 9152 B | ✅ |
| 13 | CoW VaultRelayer | `0xC92E8b…E0110` | code 4590 B | ✅ |
| 14 | 1inch | `0x111111…42A65` | code | ✅ |
| 15 | 0x AllowanceHolder | `0x000000…22734` | code | ✅ |
| 16 | **Augustus V6.2 (whitelist)** | `0x6A000F…001068` | code 24,562 B | ✅ EXACT, matches Base/mainnet |
| 17 | Odos | `0x19cEeA…6095a1` | code 20,290 B | ✅ (was unnamed last pass) |
| 18 | KyberSwap | `0x6131B5…37b5` | code | ✅ |
| 19 | OpenOcean | `0x6352a5…04e64` | code | ✅ |
| 20 | Sushi RedSnwapper | `0xAC4c6e…80b75` | code | ✅ |
| 21 | Balancer Vault | `0xBA1222…BF2C8` | code (globally disabled — inert) | ✅ |
| 22 | Uniswap SwapRouter02 | `0x68b346…65Fc45` | code 24,497 B | ✅ |
| 23 | Uniswap V3 Factory | `0x1F9843…31F984` | code 24,535 B | ✅ |
| 24 | Uniswap QuoterV2 | `0x61fFE0…30B21e` | code 8273 B | ✅ |

**Config ↔ manifest ↔ on-chain all agree.** The manifest guard (`arbitrum-manifest.test.ts`) loads the 24-entry
manifest, asserts every `ok===true`, asserts the category set = {token,feed,sequencer,contract} and count ≥24,
and via `it.each` resolves each entry's LIVE config value and asserts `live !== null` + case-insensitive address
match — so a silent hand-edit to ANY 42161 address (token, feed, sequencer, router, factory, quoter) fails CI.
The prior "unguarded" gap is closed. **Note:** `wstETH` (in the base spec's token list) is NOT in the config or
manifest (5 tokens only) — confirm it was intentionally deferred (not a blocker).

---

## Part 2 — USDT0 adjudication: ✅ ACCEPT (with a catalog-time allowlist requirement, folded into M-01)

- **(a) Dominant/canonical USDT on Arbitrum — SUBSTANTIATED.** `0xFd086bC7…FCbb9` resolves `symbol()="USD₮0"`
  (Tether's LayerZero omnichain USDT). Its identity is corroborated on-chain beyond the report's GeckoTerminal
  cross-check: it is the exact token the Arbitrum **USDT/USD Chainlink feed** (#9) is keyed to, and it carries a
  live 6-dec USDT contract. Accepted as the recognized USDT; keep the liquidity cross-check current at deploy.
- **(b) UI "USDT" label vs on-chain "USD₮0" — DOES NOT break the guard, *because the 42161 catalog is empty*.**
  `getFullCatalog(42161)` / `getPopularTokens(42161)` resolve to `CHAIN_TOKENS[42161] ?? []` = **[]** (the
  catalog-guard test itself notes 42161's catalog is "deliberately absent"), so the collision/decimals/
  verified-badge logic never sees USDT0 today. **At activation, when `CHAIN_TOKENS[42161]` is populated, a
  `symbolMismatchExempt` entry (catalog "USDT" ↔ on-chain "USD₮0", address-pinned) MUST be added** or the
  catalog-guard's symbol-mismatch check will fatal / the ✓ badge will misresolve. → part of M-01.
- **(c) No adapter quotes a different USDT — PASS.** Swap adapters are address-passthrough (they quote the
  tokenIn/tokenOut in the request, sourced from `registry.tokens` = the USDT0 address). The hardcoded mainnet
  USDT `0xdac17…` appears only in `curve.ts` (mainnet-only, fail-closed off chainId 1), `health-check.ts` /
  `quorum-check.ts` (**mainnet** source-health/quorum baselines), and mainnet feed maps — none serve an Arbitrum
  swap quote.

---

## Part 3 — activation plumbing (verified)
- **Null-default dark:** `feeCollector = process.env.NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR || null`;
  `isChainActive(42161)` gates on `feeCollector !== null`. Unset ⇒ dark. ✅
- **Order-engine isolation UNDER activation:** `ORDER_EXECUTOR_BY_CHAIN` has **no** 42161 entry →
  `getOrderExecutor(42161)=null`; `isDcaLive` is `id===8453` only. So even with `feeCollector` set, Arbitrum has
  no order executor, no DCA surface, no keeper pickup. ✅
- **clients.ts:** `VIEM_CHAINS[42161]=arbitrum` present (simulation factory). The broader "silent-chain-object-
  loss CLASS" probe across other per-chain registries was spot-checked, not exhaustively swept — no additional
  instance found in `src/lib/chains`, but I flag it as bounded diligence, not a completeness guarantee.

## Part 4 — runbook (mostly strong; one gap)
- **Manifest pre-flight HARD GATE (§1):** requires `node scripts/verify-arbitrum-addresses.mjs` to exit 0 and
  re-emit the manifest at a **fresh block that day** before deploy — explicitly citing this audit's 9 dead
  addresses. Excellent. ✅
- **FeeCollector V2 no drift:** no `.sol` changes in #303 (deploys the audited Base/mainnet source). ✅
- Whitelist = input-and-checked (bootstrap once; `cast call whitelistedRouters` incl. a negative check on the
  old V1 SwapRouter); Augustus V6.2 verified live above. ✅ Preview-strictly-before-prod with a WETH→USDC smoke,
  on-chain fee check, 12-adapter quorum; rollback = unset env ⇒ dark, no code change. ✅

### M-01 (MEDIUM · fail-safe · runbook/activation amendment) — empty token catalog
`CHAIN_TOKENS[42161]` is absent, so `getFullCatalog(42161)` is `[]` — the Arbitrum token selector is EMPTY. The
runbook's Preview smoke (§6.2: "switch to Arbitrum, execute WETH→USDC") therefore cannot be performed via the
env-flip alone: there are no selectable tokens. This is **fail-safe** (the Preview gate blocks the prod flip on
smoke failure; a determined user could still custom-import, which is unverified-but-safe), so it is not a C/H
and does not block the authorization — but the activation cannot succeed until the catalog exists. **Add to the
runbook a step (before §6 Preview) to populate `CHAIN_TOKENS[42161]` with the curated Arbitrum catalog AND add
the USDT0 `symbolMismatchExempt` allowlist entry (Part 2b), then re-run the manifest guard.** Recommend the
catalog addresses themselves be sourced from the same verified manifest (not re-typed).

## Findings
- **M-01 · runbook §6 / `tokens.ts` · MEDIUM (fail-safe).** Empty `CHAIN_TOKENS[42161]` → empty selector → the
  Preview WETH→USDC smoke can't run; USDT0 needs a `symbolMismatchExempt` entry at catalog time. Non-blocking;
  required for a successful activation.
- **L-01 · `wstETH` absent** from the 42161 token set (base spec listed it). Confirm intentional deferral.

_Prior 3 HIGH (dead addresses) independently confirmed CLOSED. Read-only; no source edited. Report + AUDIT-TOTAL
block left for the owner's SSH-signed batch (rule #12)._
