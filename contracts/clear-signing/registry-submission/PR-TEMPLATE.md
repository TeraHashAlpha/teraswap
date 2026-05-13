# Add TeraSwap FeeCollector V2 descriptor

This PR adds an ERC-7730 descriptor for **TeraSwap FeeCollector V2**, the
on-chain entry point for every swap routed through TeraSwap's
meta-aggregator (Ethereum mainnet).

## Contract

| Field | Value |
|---|---|
| Name | TeraSwap FeeCollector V2 |
| Chain | Ethereum mainnet (chainId 1) |
| Address | `0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459` |
| Etherscan | <https://etherscan.io/address/0x47f24068932Ac49bcbeD3aD105af57C6ECDF7459#code> (verified source) |
| Source | <https://github.com/TeraHashAlpha/dex-aggregator/blob/main/contracts/TeraSwapFeeCollector.sol> |

## Functions covered

| Function | Selector | Purpose |
|---|---|---|
| `swapTokenWithFee(address,uint256,address,bytes,address,uint256)` | `0x7f7663d4` | ERC-20 input swap |
| `swapETHWithFee(address,bytes,address,uint256)` | `0x7739563c` | Native-ETH input swap |

Admin functions are deliberately out of scope — only the two
user-signing functions are described. `routerData` (encoded inner-DEX
calldata) is hidden from the wallet screen via `"visible": "never"` on
its field entry in each format (ERC-7730 v2 per-field visibility, which
replaced the v1 top-level `excluded` array).

## Files

- `registry/teraswap/calldata-TeraSwapFeeCollector.json` — descriptor
- `registry/teraswap/tests/calldata-TeraSwapFeeCollector.tests.json` — test fixtures

## Verification

- Function selectors verified against the deployed bytecode (see Etherscan).
- A CI test in the source repo
  (`src/lib/erc7730-descriptor.test.ts`) re-computes the selectors on
  every build and cross-references them with the frontend's
  `FEE_COLLECTOR_ABI`. The pinned constants are `0x7f7663d4` and
  `0x7739563c`.
- Descriptor passes `erc7730 lint --skip-abi-validation` against the
  ERC-7730 v2 schema.

## Why this matters to users

TeraSwap users currently see opaque hex when they sign a swap on a
Ledger. With this descriptor merged, the Secure Screen will show the
swap intent (input token, amount, output token, minimum output, router)
— the same fields the application itself surfaces on the confirmation
screen. The H-04 on-chain `minimumOutput` check makes that figure
binding: if the user doesn't receive at least that much, the
transaction reverts.

## Audit + attestation

The TeraSwap repo runs an internal audit on every sprint; the
Sprint 15 audit (post-merge) reviews this descriptor specifically.
We're tracking ERC-8176 attestation tooling and will attach a
signed attestation once the framework lands.
