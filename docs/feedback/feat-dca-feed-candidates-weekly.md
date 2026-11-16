# Feedback: feat/dca-feed-candidates-weekly

Checklist (all done):
- [x] C1 `scripts/dca-feeds/candidates.ts` + lib + 44 fixture tests (9c32c384)
- [x] C2 28 new rows as `enabled:false, action:none, phase:2`: Base 11, Arbitrum 17; 420 insertions, 0 deletions (1dd23a19)
- [x] C3 `.github/workflows/dca-feed-candidates.yml` + `list-chains.ts` + guard test; CLAUDE.md state + AGENTS.md pin regenerated (0ca5e926)
- [x] C4 runbook section 9 step 0 (c3590b83); lint cleanup, 3 unused disable comments (9af86c78)

## 1. Premise check
- `feat/dca-feed-batch-2026-11` is on origin/main (PR #688). Branch cut from it.
- TRUE: `batch.ts` reads Chainlink's directory. But it had no reusable reader (fetch inline), so host and paths moved to
  `scripts/dca-feeds/directory.ts`, imported by `batch.ts` and `candidates.ts`; the rules are reused from `batch-lib.ts`
  (`isPlainProxy`, `liveProblems`, `MAX_STALENESS_RULE`; `isChecksummed` is now exported). No other change to `batch.ts`.
- FALSE: "match by the directory's token address". No directory entry has one (193 Base entries inspected): only `docs.baseAsset`
  (a symbol). Asked once; owner chose the exact-symbol join as in `batch.ts` (one verified EIP-55 catalog token, else "needs manual match").
- Directory (host fixed in code, never an argument): `https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json`
  and `.../feeds-ethereum-mainnet-arbitrum-1.json`.

## 2. Tables (run 2026-11-14, two RPCs; full tables: `node --no-warnings scripts/dca-feeds/candidates.ts --chain base|arbitrum`)
- **Base** (193 entries): 14 candidates, 21 excluded, 6 manual match, 38 USD feeds with no catalog token. Candidates by volume:
  WBTC low 1200s, RSR, JITOSOL, GHO, MOG*, DEGEN*, SNX, HOME low, AXL, LBTC, WELL*, SHIB low, PEPE low, MLN (* row already existed, disabled).
  Excluded: enabled or registered (USDC, LINK, AAVE, USDS, ZRO, VIRTUAL, EURC, USDT, AERO, COMP, MORPHO, YFI, CBETH, cbBTC, DAI), category new (VVV, AVNT) or high (MAMO, CBDOGE), SVR-only (ETH, SOL).
- **Arbitrum** (1747 entries): 21 candidates, 16 excluded, 4 manual match, 98 USD feeds with no catalog token. Candidates by volume:
  USDG, PEPE, ENA, USDS, RSR, ZRO, PYUSD, CAKE, 1INCH, MORPHO, GHO, YFI*, APE, GRT*, TBTC, ATH, GMX*, WOO*, AXL, SPELL, RDNT.
  Excluded: registered (USDC and the 13 phase-1 tokens), LUSD category high, ETH native placeholder.

## 3. Workflow (quoted from the file)
- `on:` `schedule: - cron: "30 6 * * 1"` and `workflow_dispatch: {}`; nothing else (pinned by `workflow.test.ts`).
- Top level `permissions: contents: read`; the one job `candidates` adds `contents: write` + `pull-requests: write`. No `issues`, no auto-merge, no key.
- Secret: only `CATALOG_PR_TOKEN`, used by `gh pr create` alone so CI starts on the PR (falls back to `GITHUB_TOKEN` with a warning). No wallet key, no RPC secret.
- `actionlint` + shellcheck clean; no `${{ }}` inside any `run:`; all `uses:` pinned to SHAs copied from `token-catalog-refresh.yml`.

## 4. Verify
`scripts/agent-verify.sh --codeql` @ 9af86c78 (base origin/main 130f2ddf): suite 10681 passed, **2 failed (pre-existing fiat, below)** ·
lint-delta PASS +0/+0 · tsc PASS · build PASS · v1v2-parity PASS 111 · rpc-budget PASS 36 · codeql PASS 13 -> 13, 0 new · keeper not requested.
`node scripts/gen-claude-state.mjs --check`: current. `actionlint` + shellcheck: clean.
diff --stat origin/main...HEAD (agent-verify, before this file's final edit): 18 files, +2165 -16 (config +420 -0; scripts/dca-feeds, workflow, runbook, CLAUDE/AGENTS pin).
Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...feat/dca-feed-candidates-weekly

## Findings
- Symbol join cannot prove token identity: a lookalike with a real symbol can pass. "24h volume" is the catalog's asset-wide CoinGecko figure,
  not liquidity on that chain (Base SHIB 2k, PEPE 308 are thin). Both are in the runbook checklist; Auditor reads the monthly batch.
- On-chain ahead of config: Arbitrum USDC and Base DAI are registered in `tokenUsdFeeds` but have no config row (not planned, verified or mirrored). Owner to decide.
- Pre-existing red: `src/ui/v2/fiat/fiat.test.tsx` (2 clock-bound tests) fails the same on main 7e566fd1 and with this branch's config stashed. Untouched here.
- The workflow only runs from main; first run by `workflow_dispatch`. No failure-alert issue (minimal permissions): a red run is the signal.
  Like the catalog PRs, the two chain PRs edit one file, so "require up-to-date" can stall the second until Update branch.
