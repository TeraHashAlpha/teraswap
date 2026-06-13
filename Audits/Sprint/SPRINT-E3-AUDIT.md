# Sprint E-3 Audit — Portfolio Base Activation (chain-aware data)

**Branch:** `fix/e3-portfolio-base` / PR #166
**Scope (per owner brief):** LIGHT review — chain-aware data correctness + mainnet byte-identical. Data
multi-chain, **not** a security gate.
**Auditor:** independent Auditor (Opus 4.8), read-only on source.
**Commits reviewed:** `56594a9` (chain-aware portfolio API routes), `b061695` (useTokenBalances
widened), `3d07294` (usePortfolio chainId end-to-end), `3fc4abf` (FEEDBACK). All four carry SSH
signature headers (`gpgsig … BEGIN SSH SIGNATURE`) — rule #12 satisfied. (A 5th doc commit `3a1417e`
on the branch pre-declares an APPROVED machine-record; treated skeptically and re-derived below — it
is **not** unsigned-source and does not affect the verdict.)
**Diff:** 11 files, +404/−112. No Solidity, no adapter, no gate, no constants/fee/router changes.

---

## Verdict: APPROVED — 0C / 0H / 0M / 2L-I

Independent review confirms the change is chain-aware, fail-closed on unsupported chains, and
mainnet-response byte-identical. Tests are real and were **re-executed in-session: 42/42 pass** across
the four touched files. No Critical/High. The two notes below are non-blocking.

---

## Checks run (independent, code-traced)

| # | Check | Result |
|---|-------|--------|
| 1 | **Alchemy endpoint per chain** — mainnet pin byte-identical | ✅ `ALCHEMY_BASE_BY_CHAIN[1]` = `https://eth-mainnet.g.alchemy.com/v2` (string-identical to the deleted `ALCHEMY_BASE`); `[8453]` = `base-mainnet`. URL = `${alchemyBase}/${apiKey}`. Test-pinned (default→eth-mainnet, 8453→base-mainnet). |
| 2 | **UNMAPPED chain → 400 fail-closed (not silent wrong-chain)** | ✅ tokens route: `!Number.isInteger(chainId) || !alchemyBase` → 400 **before** the apiKey read and any upstream `fetch`. prices route: `!Number.isInteger(chainId) || !getSupportedChainIds().includes(chainId)` → 400 before `fetchDefiLlamaPrices`. Both test-pinned (`chainId=999999` → 400, upstream `not.toHaveBeenCalled()`). |
| 3 | **DefiLlama slug via `getChainConfig(chainId).slug`** | ✅ On-source-verified registry: `getChainConfig(1).slug === 'ethereum'` (byte-identical to the old hardcoded `'ethereum'`), `getChainConfig(8453).slug === 'base'` (correct `coins.llama.fi` namespace). Test-pinned both ways. |
| 4 | **chainId threaded end-to-end** | ✅ `useActiveChainId()` → `useDiscoveredTokens(address, chainId)` (URL `&chainId=`, effect dep `[address, chainId, refreshCounter]`), `fetchPricesBatched(addresses, chainId)`, `useBalance({ chainId: activeChainId })`, and the curated metadata map + fallback walk all key off the same `activeChainId`. A `prevChainRef` effect clears the previous chain's tokens **synchronously** on switch — no render frame can mix chain-A tokens with chain-B prices. |
| 5 | **Internal mainnet-pinned fallback replaced by standalone chain-aware `useTokenBalances`** | ✅ The deleted internal hook gated on `chain?.id === CHAIN_ID` (mainnet-only, `DEFAULT_TOKENS`-only). Replaced by `./useTokenBalances`, gated on `isChainActive(activeChainId)` with the active chain's catalog. Wiring: `useTokenBalances(!useAlchemyPath)` parks the multicall while Alchemy discovery is live; `enabled=false` disables both wagmi reads (test-pinned). No ETH double-count (native balance gated to the Alchemy path only). |
| 6 | **Mainnet byte-identical (test-pinned)** | ✅ chainId absent → identical Alchemy URL, identical curation map identity (`DEFAULT_TOKENS`/`DEFAULT_BY_ADDRESS`), identical `'ethereum'` slug, identical response shape/headers. Client now sends explicit `chainId=1`, which the routes treat identically to absent (both read the same default branch). 20 pre-existing usePortfolio tests pass unchanged. |
| 7 | **Base-fallback test is real** (Alchemy 503 on 8453 → multicall fetches Base balances) | ✅ Test sets `chain.id=8453`, discovery returns 503 → `isAvailable=false` → `useAlchemyPath=false` → multicall path active; asserts the held token is **Base** USDC (`0x833589…2913`, 6dp), `balanceFormatted==='5'`, and discovery+prices URLs carry `chainId=8453`. Genuinely exercises chainId threading + chain-aware fallback catalog. (Test isolates `isChainActive` via mock — appropriate for a unit test; production `isChainActive(8453)` is the activation guard's responsibility, env-gated on `NEXT_PUBLIC_BASE_FEE_COLLECTOR`, covered by Sprint 45.) |
| 8 | **9P cross-chain mislabel guard** | ✅ Curation is chain-scoped: `curatedFor(8453)` builds from `getChainTokenList(8453)`, never `DEFAULT_TOKENS`. Test-pinned: Base USDC flagged `isDefault:true` from the **Base** list, never labeled with mainnet metadata. |
| 9 | **No gate / FeeCollector / adapter / contract changes** | ✅ Diff touches only `app/api/portfolio/*`, `hooks/usePortfolio`, `hooks/useTokenBalances`, `components/TokenSelector`, tests, FEEDBACK. Zero changes to chainlink/price-gate/defillama/sequencer/adapters/Solidity. |
| 10 | **No `NEXT_PUBLIC_` secret leak, keys server-only** | ✅ `ALCHEMY_API_KEY` read server-side only (`process.env.ALCHEMY_API_KEY`, no `NEXT_PUBLIC_` prefix). `NEXT_PUBLIC_BASE_FEE_COLLECTOR` is a public contract address, not a secret. |
| 11 | **Any chain ≠ 1/8453 handled safely** | ✅ `CHAIN_CONFIGS`/`getSupportedChainIds()` = exactly `{1, 8453}`, identical to the tokens route's Alchemy map. Both routes 400 on anything else. A wallet sitting on an unsupported chain → discovery 400 → after `MAX_DISCOVERY_FAILURES` (=2) → multicall, which gates `isChainActive=false` → empty (no wrong-chain data). Never serves another chain's balances/prices. |
| 12 | **All `useTokenBalances` call sites migrated** (return shape `Map` → `{balances,…}`) | ✅ Two callers: `TokenSelector` (`const { balances: balanceMap }`) and `usePortfolio` (`useTokenBalances(!useAlchemyPath)`). No unmigrated caller — no "updated here but not there" break. |
| 13 | **Tests re-executed in-session** | ✅ `vitest run` on the 4 touched files: **42 passed / 0 failed**. (Branch record's "54/54" reflects a different count; substance — all green — independently confirmed.) |

---

## Findings

| ID | Severity | file:line | Disposition | Description |
|----|----------|-----------|-------------|-------------|
| E3-L-01 | LOW / INFO | `tokens/route.ts:33` vs `prices/route.ts` (`getSupportedChainIds`) | REPORT | The "supported chains" allowlist is defined **twice**: the prices route derives it from the registry (`getSupportedChainIds()` = `{1,8453}`), the tokens route from the hardcoded `ALCHEMY_BASE_BY_CHAIN` map (`{1,8453}`). Identical today, but a future 3rd chain added to the registry (with a DefiLlama slug) but not to the Alchemy map would make prices 200 while tokens 400 — a latent drift, not a current defect (both still fail-closed, read-only path). Recommend a single shared `PORTFOLIO_SUPPORTED_CHAINS` source. |
| E3-I-01 | INFO | both routes (`Number(chainIdParam)`) | REPORT | `Number()` accepts hex/scientific forms (`chainId=0x1`→1, `1e0`→1). Harmless: result is validated against a fixed 2-chain allowlist and the path is read-only (no fund flow). Noted for completeness, not a fix. |

(Carried, re-confirmed from FEEDBACK / branch record, both INFO, no action for approval: `ALCHEMY_API_KEY`
is one key for both endpoints — deploy checklist should confirm it is app-scoped across eth-mainnet +
base-mainnet; a network-restricted key degrades that chain's discovery to 503 and the chain-aware
multicall fallback covers it, same degradation path as before.)

**No remediation prompts required** — zero Critical/High/Medium; both notes are REPORT-only.

---

## Resolved design questions

1. **Unsupported active chain UX delta:** the old internal guard (`chain?.id === 1`) hid the portfolio
   entirely off-mainnet; the standalone hook now shows the mainnet portfolio as a fallback view when
   `useActiveChainId()` falls back to mainnet. Strictly more (chain-correctly labeled) information —
   judged an improvement, not a regression. ACCEPTED.
2. **Two-place chain allowlist (E3-L-01):** ACCEPTABLE for merge (identical sets, fail-closed). A
   shared constant is a clean low-priority follow-up.

## Human-only boundary
Post-merge live check (owner): Base-funded wallet → Portfolio shows Base balances + USD; mainnet ⇄ Base
switch shows no cross-chain mixing. CI (linux-x64) is the authoritative test gate; in-session
re-execution required supplying the linux-arm64 rolldown binding (the mounted `node_modules` was built
for macOS) and then passed 42/42.
