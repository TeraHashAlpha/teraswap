# feat/ui-v2-portfolio — raw evidence (2026-11-03)

## Suite / lint / tsc / build (branch 7b5a82c vs origin/main 19cced7)
- vitest main: 404 files / 6423 tests pass · branch: 409 files / 6485 tests pass (+5 files, +62 tests; 0 failures)
- lint main: 93 problems (0 errors, 93 warnings) · branch: 93 (0 errors) → delta 0
- tsc --noEmit: exit 0 · next build: exit 0 (branch and main)

## v1 proof (module-identical standard, see memory ui-v2-shell-findings)
- git diff origin/main --name-only outside src/ui/v2 + docs/feedback: (empty). src/lib, src/hooks, src/app/api, src/components: 0 files.
- next build route table, branch vs main: IDENTICAL (59 lines, diff empty).
- v1 route chunks (build-manifest + client-reference-manifest): '/' 6 chunks 556589 B both, '/swap' 6 chunks 556589 B both; 0 chunks with v2 markers.
- All client chunks: 248 each; 6 file names differ (Turbopack regroup): 3 carry v2 markers (v2 routes), 3 are shared-chunk regroups.

## CodeQL (scripts/codeql-local.sh, qls = codeql/javascript-queries:codeql-suites/javascript-security-extended.qls)
    --- results (file:line) ---
    scripts/capture-endpoint-baseline.ts:241
    scripts/capture-endpoint-baseline.ts:54
    scripts/setup-telegram-webhook.ts:34
    scripts/verify-arbitrum-addresses.mjs:238
    scripts/verify-arbitrum-chainlink-feeds.mjs:179
    src/app/api/orders/route.ts:165
    src/app/api/orders/route.ts:165
    src/app/api/orders/route.ts:174
    src/app/api/orders/route.ts:174
    src/app/api/orders/route.ts:256
    src/app/api/orders/route.ts:256
    src/app/api/orders/route.ts:481
    src/app/api/orders/route.ts:493
    src/app/api/telegram/webhook/route.ts:163
    src/components/TokenAddressBadge.tsx:124
    src/lib/api-auth.ts:94
    src/lib/auth.ts:47
    src/lib/fingerprint-validator.ts:319
    src/lib/rpc-env.ts:91
    total: 19
    exit 0
- None of the 19 is under src/ui/v2 or docs/feedback (all pre-existing: scripts/, src/app/api, src/lib, TokenAddressBadge).

## rpc-budget (src/ui/v2/__tests__/rpc-budget, 26/26 pass; scenario p added)
| UI | state | mount burst | steady/min | hidden 60 s | on return (5 s) |
| v1 | p | 4 (eth_blockNumber×1 eth_call×3) | 4 | 0 | 4 |
| v2 | p | 4 (eth_blockNumber×1 eth_call×3) | 4 | 0 | 4 |
Budget p ≤ 6/min, mount ≤ 12. Unmounted tab: 0 API calls + 0 balance reads over 10 min (portfolio-chain.test.tsx).

## Parity output
[parity chain 1] v1 text nodes 34 · missing 0 · missing hrefs 0   [parity chain 8453] 28 · 0 · 0   [parity chain 42161] 22 · 0 · 0
[approvals] v1 nodes 27, hrefs 1, missing text 0, missing hrefs 0 (Revoke.cash href identical, parsed hostname asserted)
[states] populated 22 · disconnected 1 · unavailable(10/137/56) 3 · loading 3 · refreshing 22 · error 5 · error+rows 24 · empty(1/8453/42161) 6
         unpriced total 9 · clock 7 s/95 s/3 h 22 each → every run: missing 0, and visibleTextNodes(v2) toEqual visibleTextNodes(v1)
Explorer assertions: new URL(href).hostname === etherscan.io / basescan.org / arbiscan.io per chain, pathname /tx/<hash>; revoke.cash by hostname.
Nothing signs or sends: wagmi useWriteContract / useWaitForTransactionReceipt / fetch / RPC are fakes; Revoke only on a press (call args == v1's).
