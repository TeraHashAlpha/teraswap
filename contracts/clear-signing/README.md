# TeraSwap Clear Signing (ERC-7730)

When a TeraSwap user signs a swap on a hardware wallet today, they see a
raw hex blob — "blind signing." There is no human-readable way to
verify what's about to execute. The Ethereum Foundation's May 2026
clear-signing initiative makes [ERC-7730][erc7730] the standard way to
fix this: a JSON descriptor that maps each function's calldata onto
labelled, formatted fields the wallet can render.

The descriptor in this directory targets **TeraSwap FeeCollector V2** at
`0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` on Ethereum mainnet. Once
merged into the [LedgerHQ clear-signing registry][registry], Ledger's
Secure Screen will replace raw hex with intents like:

> Swap 1,500 USDC → ETH via TeraSwap
> Minimum Output: 0.42 ETH
> Router: Uniswap V3 SwapRouter02

Trezor, MetaMask, WalletConnect, and other adopters of the same
descriptor format will follow.

## What's covered

The descriptor maps the **two user-facing functions** on FeeCollector V2:

| Function | Selector | Purpose |
|---|---|---|
| `swapTokenWithFee(address,uint256,address,bytes,address,uint256)` | `0x7f7663d4` | ERC-20 input swap |
| `swapETHWithFee(address,bytes,address,uint256)` | `0x7739563c` | Native-ETH input swap |

Admin functions (`setFee`, `pause`, `queueRouterChange`, etc.) are
intentionally **out of scope** — the descriptor is for the user-signing
path. Wallets will still blind-sign admin calls because those touch
multisig flows where extra opacity is acceptable.

`routerData` is hidden from the user-facing screen via `"visible": "never"`
on its field entry in each format (ERC-7730 v2 replaces the v1 top-level
`excluded` array with per-field visibility). It's encoded calldata for
the inner DEX router (1inch / Uniswap V3 / Curve / …) — opaque bytes
that can't be meaningfully shortened. The on-chain H-04 `minimumOutput`
check is the user-visible guarantee, and the descriptor surfaces that
prominently instead.

## Verifying the descriptor against the deployed contract

Three independent checks gate this directory:

1. **`src/lib/erc7730-descriptor.test.ts`** — re-computes the
   keccak256 selector for each function signature in the descriptor and
   asserts it matches the pinned constant (`0x7f7663d4` and
   `0x7739563c`). It also cross-references each function against
   `FEE_COLLECTOR_ABI` in `src/lib/constants.ts`, which is the ABI the
   frontend uses to encode calls. Drift on either side breaks the test.
2. **`erc7730 lint`** — Ledger's official CLI validates the descriptor
   against the v2 schema. Install (Python 3.12 required by the package):

   ```bash
   python3.12 -m venv /tmp/erc7730-venv
   /tmp/erc7730-venv/bin/pip install erc7730
   /tmp/erc7730-venv/bin/erc7730 lint --skip-abi-validation \
     contracts/clear-signing/registry-submission/calldata-TeraSwapFeeCollector.json
   ```

   The registry's CI runs the same command — any schema regression
   surfaces locally before the PR.
3. **Etherscan verified source** — the deployed bytecode at
   `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` is verified against
   `contracts/TeraSwapFeeCollector.sol`. The function signatures in
   that file are the same ones the descriptor describes.

If you want to verify the selectors by hand:

```
cast 4byte-decode 0x7f7663d4
# swapTokenWithFee(address,uint256,address,bytes,address,uint256)

cast 4byte-decode 0x7739563c
# swapETHWithFee(address,bytes,address,uint256)
```

## Submitting to the registry

After audit approval, the maintainer (TeraHash) submits a PR to the
clear-signing registry:

1. Fork [`LedgerHQ/clear-signing-erc7730-registry`][registry]
2. Create `registry/teraswap/` and copy two files into it:
   - `calldata-TeraSwapFeeCollector.json` — the descriptor. Filename
     follows the registry's `calldata-<ContractName>.json` convention
     (contract name from `metadata.contractName`).
   - `tests/calldata-TeraSwapFeeCollector.tests.json` — at least one
     mainnet `rawTx` for the registry's automated checks. The version
     in this repo ships a structurally-valid placeholder; replace its
     `rawTx` + `txHash` with a real on-chain transaction before opening
     the PR.
3. Open a PR using the template in `registry-submission/PR-TEMPLATE.md`.

Anthropic-style "do this for the user" is intentionally out of the code
agent's scope — submitting to an external repo is a manual step with
account-level implications.

## References

- ERC-7730 standard: <https://eips.ethereum.org/EIPS/eip-7730>
- v2 schema (registry):
  <https://github.com/LedgerHQ/clear-signing-erc7730-registry/blob/master/specs/erc7730-v2.schema.json>
- erc7730 CLI: <https://pypi.org/project/erc7730/> (Python ≥ 3.12, < 3.13)
- Registry: <https://github.com/LedgerHQ/clear-signing-erc7730-registry>
- Ledger docs: <https://developers.ledger.com/docs/clear-signing/overview>
- TeraSwap FeeCollector V2 source:
  [`../TeraSwapFeeCollector.sol`](../TeraSwapFeeCollector.sol)

[erc7730]: https://eips.ethereum.org/EIPS/eip-7730
[registry]: https://github.com/LedgerHQ/clear-signing-erc7730-registry
