# CHORE-REMOVE-GELATO — drop the deprecated Gelato keeper from the repo

Gelato Web3 Functions were **deprecated March 2026** and replaced by the self-hosted executor
(`contracts/order-engine/executor/`) — see `ROADMAP.md` ("self-hosted executor (replaced Gelato)"). The
Gelato code is now dead weight and the order-engine README still describes Gelato as the live execution
path, which is misleading. Clean it up. Branch `chore/remove-gelato`, atomic SSH-signed commit(s), CI green
incl. test-contracts, append `FEEDBACK.md`. No app behaviour change.

## P1 — Remove the dead Gelato code
- First **prove it's dead**: confirm `contracts/order-engine/gelato/` (`web3Function.ts`, `package.json`)
  is referenced nowhere in `src/`, `contracts/order-engine/executor/`, build scripts, CI, or package.json
  scripts. (Current grep: zero references in `src/`.) If ANY live reference exists, STOP and report.
- If provably dead: **remove the `contracts/order-engine/gelato/` directory.** Git history preserves it
  (per the CHORE-POLISH-4 dead-code precedent). Note the removal in FEEDBACK. (Rule #4 nuance: this is an
  orphaned, superseded off-chain subsystem, not a doc/ADR referenced as historical record.)

## P2 — Update `contracts/order-engine/README.md` to the self-hosted executor
Replace the Gelato-centric content with the actual keeper (`executor/executor.js`). Update at least:
- **EXECUTION FLOW** diagram (currently "Gelato Web3 Function (runs every 30s)…") → self-hosted executor
  polling Supabase, calling `canExecute()`, then `executeOrder()`.
- **Components** table (the "Gelato Function | gelato/web3Function.ts" row) → `executor/executor.js`.
- **Deployment Steps** §3 ("Deploy Gelato Web3 Function") → run the self-hosted executor (env:
  `EXECUTOR_PRIVATE_KEY` or `KMS_KEY_ID`/`VAULT_ADDR`, `RPC_URL`, `SUPABASE_*`, `ORDER_EXECUTOR_ADDRESS`,
  `CHAIN_ID`). Keep it accurate to `executor.js`.
- **Fee Structure** ("Gelato execution fees paid from prepaid Gelato balance") → executor wallet pays gas
  directly (must be funded).
- **Roadmap Phase 1** (the Gelato checkboxes) + **Security §5 "Gelato Trust"** → reflect self-hosted keeper.
- Keep the on-chain security points (EIP-712, Chainlink, router whitelist, nonce, minAmountOut) intact.

## Do NOT
- **Do NOT modify `TeraSwapOrderExecutor.sol`.** It is deployed/immutable on mainnet and will be redeployed
  byte-identical on Base (see `docs/Runbooks/BASE-ORDEREXECUTOR-DEPLOY.md`). Leave the "GELATO CHECKER"
  comment on `canExecute` as-is — `canExecute` is a generic view STILL USED by the self-hosted executor;
  do not remove or rename it. (A comment-only relabel would change the source vs the verified mainnet
  source — avoid it.)
- Do NOT touch the live app (`src/`), the executor (`executor/`), or any contract logic. No behaviour change.

## Output
- Branch `chore/remove-gelato`; `gelato/` removed (if proven dead) + README updated; CI + test-contracts
  green; FEEDBACK with the dead-code proof (grep results) + what changed in the README.
- No Auditor needed (docs + dead off-chain code only). Flag for Architect if any live reference to `gelato/`
  is found (means it's not actually dead).
