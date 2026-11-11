# contracts/order-engine — OrderExecutor contracts and the keeper

Scoped to `contracts/order-engine/` (Solidity, Foundry) and `contracts/order-engine/executor/` (the self-hosted keeper, plain Node ESM).
Root rules in `/CLAUDE.md` still apply. This is fund-flow code: no change merges without the owner and, where the root rules say so, an
Auditor pass with 0 Critical / 0 High.

## Contracts
- A contract change needs the Architect, then an Auditor pass with 0C/0H, then a gated deploy — never "on this ADR alone"
  (`docs/ADR/ADR-013-order-onchain-floor.md:45, 58`; root Do NOT 2 and 3). The executors are not upgradeable, so a change is a new address
  plus a migration (`ADR-013:8, 47`). Check `docs/security/AUDIT-TOTAL.md` for open findings first.
- Admin changes sit behind the contract's own 48 h / 7 d timelocks; `pause`, `unpause` and `setOracleConfig` execute instantly by design
  (`ADR-013:53`, `docs/ADR/ADR-019-trigger-feed-timelock-asymmetry.md`).
- Addresses come from `docs/DEPLOYMENTS.md` only, qualified by chain: one address is a different contract on different chains.
- CI runs `forge test -vvv` here and the FeeCollector suite in `contracts/` (`.github/workflows/ci.yml:505-526`). Running `forge test`
  rewrites the tracked `cache/solidity-files-cache.json`: `git checkout` it before you commit.

## Keeper
- CI runs the keeper suite on Node 22 (`ci.yml:485-503`, `npm ci` + `node --test`) AND on Node 20 (`keeper-tests.yml:43`, `npm ci
  --ignore-scripts` + `node --test`). A green run on a newer local Node is not a CI result; run `cd contracts/order-engine/executor &&
  node --test` on 20 and 22. Measured 2026-11-11 on Node 25.6.1: 1240 tests (52 top-level `*.test.mjs` files), 0 failed.
- ADR-026 (Proposed): a miss caused by OUR infrastructure never counts against a user's order. Only an `order` miss advances
  `consecutive_failures` and the 8-miss ladder; `infra` needs "no tx sent"; a miss with no evidence stays counted as `order:unknown`
  (`ADR-026:50-52, 56-57`; `retry-policy.js:40-57`). Anything that changes which misses count needs an Auditor (`ADR-026:11-13`).
  Pinned by `miss-cause.test.mjs`, `infra-miss-ladder.test.mjs`, `wrapped-viem-errors.test.mjs`.
- Price floor (ADR-024, Accepted): a DCA fill needs a quorum of independent prices; with none, skip the cycle — never cancel the order,
  never fill blind (`docs/ADR/ADR-024-dca-price-quorum.md:12-22`).
- Boot is a gate, not a warning: `CHAIN_ID` is required with no default, one instance per chain, and the chain, contract and signer are
  verified before any work; a FATAL chain-verify line is the gate working (`executor.js:40-62`).

## Logs and alerts
- Text bound for a log line or a Telegram alert goes through `redact.js` (`redactUrl`, `redactError`): a provider key sits in the RPC URL
  path and once reached Telegram in full (INC-2026-10-30-001, `redact.js:1-9`). Never interpolate a raw `err.message` or an RPC URL.
  Pinned by the `redact*.test.mjs` files; `rpc-auth.js` classifies on redacted text only (`rpc-auth.js:16`).

## Signer and host
- Production chains sign with AWS KMS: `KMS_KEY_ID` plus `KMS_REGION`, which has no default region (`executor.js:447`). A plaintext
  `EXECUTOR_PRIVATE_KEY` is FATAL on every chain except Sepolia and Base Sepolia unless `ALLOW_PLAINTEXT_KEY` is set (`executor.js:280, 463`);
  `VAULT_ADDR` is not wired (`:439`). Never set the override. Signers per chain: "Keeper registry" in `docs/DEPLOYMENTS.md`.
- An agent never reaches the keeper host: no `ssh`, no `pm2`, no reading `.env.executor` or its logs. Runbooks for the owner:
  `docs/Runbooks/EXECUTOR-OPERATIONS.md`, `docs/Runbooks/EC2-EXECUTOR-HOST.md`. Prepare the command, stop, report.
