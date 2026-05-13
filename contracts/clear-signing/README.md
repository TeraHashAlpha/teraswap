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

`routerData` is explicitly listed under `excluded` in both formats. It's
encoded calldata for the inner DEX router (1inch / Uniswap V3 / Curve /
…) — opaque bytes that can't be meaningfully shortened. The on-chain
H-04 `minimumOutput` check is the user-visible guarantee, and the
descriptor surfaces that prominently instead.

## Verifying the descriptor against the deployed contract

Two independent checks live in this repo and run on every CI build:

1. **`src/lib/erc7730-descriptor.test.ts`** — re-computes the
   keccak256 selector for each function signature in the descriptor and
   asserts it matches the pinned constant (`0x7f7663d4` and
   `0x7739563c`). It also cross-references each function against
   `FEE_COLLECTOR_ABI` in `src/lib/constants.ts`, which is the ABI the
   frontend uses to encode calls. Drift on either side breaks the test.
2. **Etherscan verified source** — the deployed bytecode at
   `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` is verified against
   `contracts/TeraSwapFeeCollector.sol`. The function signatures in
   that file are the same ones the descriptor describes.

If you want to verify by hand:

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
2. Copy the file from `registry-submission/` into
   `registry/teraswap/calldata-FeeCollectorV2.json` per the repo's
   contribution guide. The folder name is `teraswap` (slug); the file
   name follows the registry's `calldata-<ContractName>.json`
   convention.
3. Open a PR using the template in `registry-submission/PR-TEMPLATE.md`.

Anthropic-style "do this for the user" is intentionally out of the code
agent's scope — submitting to an external repo is a manual step with
account-level implications.

## References

- ERC-7730 standard: <https://eips.ethereum.org/EIPS/eip-7730>
- Schema:
  <https://eips.ethereum.org/assets/eip-7730/erc7730-v1.schema.json>
- Registry: <https://github.com/LedgerHQ/clear-signing-erc7730-registry>
- Ledger docs: <https://developers.ledger.com/docs/clear-signing/overview>
- TeraSwap FeeCollector V2 source:
  [`../TeraSwapFeeCollector.sol`](../TeraSwapFeeCollector.sol)

[erc7730]: https://eips.ethereum.org/EIPS/eip-7730
[registry]: https://github.com/LedgerHQ/clear-signing-erc7730-registry
