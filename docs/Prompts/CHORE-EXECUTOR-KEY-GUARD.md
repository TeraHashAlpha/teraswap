# CHORE-EXECUTOR-KEY-GUARD — plaintext-key refusal must cover all production chains (incl. Base)

The self-hosted executor `contracts/order-engine/executor/executor.js` refuses a plaintext
`EXECUTOR_PRIVATE_KEY` **only when `CHAIN_ID === 1`** (mainnet). On **Base (8453)** — also real funds — the
guard does not fire, so a plaintext key would be silently accepted. Before running the executor on Base,
extend the guard to all production chains. Branch `chore/executor-key-guard`, SSH-signed commit, append
`FEEDBACK.md`. Off-chain executor only — no contract, no `src/`, no app behaviour change.

## Requirements
- In `executor.js`, replace the mainnet-only plaintext check (currently gated on `CHAIN_ID === 1`, around
  the `hasKey`/`ALLOW_PLAINTEXT_KEY_MAINNET` block, ~lines 155-173) with a **production-chain** check:
  - Define an explicit testnet allowlist (e.g. `TESTNET_CHAIN_IDS = new Set([11155111 /* Sepolia */, 84532 /* Base Sepolia */, ...])`).
  - Plaintext `EXECUTOR_PRIVATE_KEY` is allowed ONLY when `CHAIN_ID` is in the testnet set. On ANY other
    chain (1, 8453, and future prod chains) a plaintext key is **FATAL** (`process.exit(1)`) unless the
    explicit override is set. Prefer KMS (`KMS_KEY_ID`) / Vault (`VAULT_ADDR`).
  - Keep the existing override escape hatch but make its name chain-accurate: accept the current
    `ALLOW_PLAINTEXT_KEY_MAINNET` for back-compat AND a new generic `ALLOW_PLAINTEXT_KEY` (either enables
    the bypass). Document both in the header env comment block.
  - Update the FATAL/ WARNING log messages so they name the actual chain (not hardcoded "mainnet (CHAIN_ID=1)").
- Behaviour on chainId 1 is unchanged (still refuses plaintext). New: chainId 8453 now also refuses.
  Testnets (Sepolia) still allow plaintext for dev.

## Verify
- A test or a documented manual check: `CHAIN_ID=8453` + plaintext key (no KMS/Vault, no override) → process
  exits with the FATAL message; `CHAIN_ID=8453` + `KMS_KEY_ID` set → starts; `CHAIN_ID=11155111` + plaintext
  → starts (testnet); `CHAIN_ID=1` + plaintext → still FATAL (unchanged).

## Do NOT
- No changes to the contract, `src/`, or the executor's signing/execution logic beyond the guard. Keep
  KMS/Vault paths intact. SSH-signed commit, FEEDBACK with the before/after guard logic + which env names
  enable the bypass. No Auditor needed.
