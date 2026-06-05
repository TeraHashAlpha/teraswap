# SPRINT-9L — Remove premature P184 Coinbase parallel dep (post-9K hygiene)

## Context
9K (INC-2026-06-03-001) found that commit `4f6f70c` [P184] "preinstall wallet connector deps for
wagmi v3 readiness" added premature DIRECT wallet-connector deps that created parallel stacks. 9K
removed `@walletconnect/ethereum-provider`. The SAME anti-pattern remains for Coinbase:

- `package.json` has `@coinbase/wallet-sdk: 4.3.7` as a DIRECT dep (P184 leftover).
- `@wagmi/connectors` (via wagmi 2.19.5 / RainbowKit getDefaultConfig) depends on its OWN
  `@coinbase/wallet-sdk@4.3.6` (kept NESTED because of the version mismatch) plus an internal aliased
  `cbw-sdk: npm:@coinbase/wallet-sdk@3.9.3`.
- Result on disk: `node_modules/@coinbase/wallet-sdk@4.3.7` (root, hoisted) AND
  `node_modules/@wagmi/connectors/node_modules/@coinbase/wallet-sdk@4.3.6` (nested).
- **Nothing in `src/` imports `@coinbase/wallet-sdk` / CoinbaseWalletSDK** — the connector is set up
  automatically by RainbowKit and resolves the nested 4.3.6. The root 4.3.7 is unused.

Unlike the WC case, npm nested wagmi's copy, so the Coinbase connector is self-consistent and likely
WORKS today — this is latent-risk + dead-weight cleanup, not a confirmed active outage. Still worth
removing: same P184 anti-pattern, unused, parallel-stack risk.

## Objective
Remove the unused premature `@coinbase/wallet-sdk@4.3.7` direct dependency so wagmi's own bundled
Coinbase SDK is the single source, mirroring the 9K WC dedup. Coinbase Wallet must still connect.

## Requirements
1. Confirm (don't assume) nothing in `src/` imports `@coinbase/wallet-sdk` directly — grep again.
   If any direct import exists, STOP and report (removal would break it).
2. Remove `@coinbase/wallet-sdk` from `package.json` dependencies. Regenerate the lockfile. Verify
   the Coinbase connector still resolves through `@wagmi/connectors` (its nested 4.3.6 + aliased
   cbw-sdk are wagmi-internal and fine). Preserve the 8 `@next/swc` platform optionals in the lock
   (same Linux-CI safety note as 9K).
3. Do NOT change the WalletConnect overrides or any 9K work. Do NOT touch projectId/RPC/safety
   gates/contracts. Swap behaviour byte-identical.
4. Verify: tsc + lint clean, full test suite, `next build` ✓, `npm ci --dry-run` valid. Manually
   confirm Coinbase Wallet still appears and connects (runtime — note in FEEDBACK, same caveat as
   9K that wallet connection is relay/runtime behaviour).
5. Branch `feat/sprint-9l-coinbase-dep-cleanup` off latest `origin/main`, atomic SSH-signed commits,
   CI green, append FEEDBACK. Not a security gate → no Auditor; Preview-test before prod.

## Out of scope (other P184/wagmi-v3 follow-ups — separate)
- www-vs-apex host alignment (canonical/origin/WC metadata) — pending owner's host decision.
- `@next/swc` lockfile pruning recurring on darwin `npm install` — project-level fix.
- The wagmi v3 migration proper (ADR-008).
