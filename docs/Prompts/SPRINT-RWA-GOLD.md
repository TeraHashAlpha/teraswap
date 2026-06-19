# SPRINT-RWA-GOLD

Branch: `sprint/rwa-gold` (off `origin/main` — catalog clean + guarded by #209/#211). No Auditor. Owner signs off
addresses before merge.

## Context

The token catalog is now clean and guarded (catalog-address-guard validates every entry: trusted-list, on-chain
bytecode + identity, decimals, transferability, no duplicate symbol). Add the first real-world-asset category:
tokenized physical gold.

## Objective

Add a `Gold` category with **PAXG** (primary) and **XAUT** (secondary), each fully verified, mainnet-only unless a
liquid Base token is confirmed. No investment/yield framing.

## Requirements (per token)

1. Confirm the address against the **official issuer** (Paxos / Tether).
2. Verify **on-chain**: `symbol()`, `decimals()`, transferability.
3. Confirm **routable DEX liquidity** (a real quote routes through a whitelisted router).
4. **Per-chain**: check Base; add a Base entry only if a verified + routable Base token exists.
5. **Real logos**; **no** investment/yield language.
6. The new entries must pass the catalog-address-guard; run `npm run guard:refresh`; keep the CI job green.

## Do NOT

- Invent addresses; add anything not verifiably routable; add a Base entry without a confirmed liquid Base token.
- Market as investment/yield.

## Disposition (as implemented)

| symbol | address | on-chain | issuer | liquidity |
|---|---|---|---|---|
| **PAXG** | `0x45804880De22913dAFE09f4980848ECE6EcbAf78` | PAXG/18/transferable | Paxos (Etherscan-verified) | Uniswap PAXG/WETH ~$12.7M |
| **XAUT** | `0x68749665FF8D2d112Fa859AA293F07A622782F38` | XAUt/6/transferable | Tether (Etherscan-verified) | Uniswap XAUt/USDT ~$10.3M |

Mainnet-only (no PAXG/XAUT on Base — the Base "gold" tickers are unrelated projects). `'Gold'` added to
`TokenCategory` + display order; PAXG re-categorised Other→Gold; XAUT added to `DEFAULT_TOKENS` (decimals 6,
dedupes the generated long-tail). `guard:refresh` → guard 16/16. FEEDBACK carries the proposed final list (for
owner sign-off) + surfaced (not added) RWA candidates (XAUM thin; Ondo tokenized stocks are permissioned).

## Expected output

PAXG/XAUT under Gold; guard + CI green; FEEDBACK = proposed final list (address/chain/on-chain symbol+decimals/
official-source/liquidity) for owner sign-off + surfaced candidates. tsc/lint/tests/build/test-contracts green.

## Quality criteria

Every address issuer-confirmed + on-chain-verified + routable; mainnet-only justified; the guard (the regression
net) validates the new entries and stays green; nothing framed as investment/yield.
