# SPRINT-9D — Add Bebop as a chain-agnostic source (Ethereum + Base)

Implements [ADR-010](../ADR/ADR-010-bebop-rfq-source.md). One atomic, signed commit per prompt; record the hash in this packet.

---

## P228 — Bebop Aggregation (JAM) adapter, chain-aware (chains 1 + 8453)

### Context
TeraSwap is a meta-aggregator with 11 chain-aware sources behind a `DEXAdapter`
interface (`fetchQuote`, `fetchSwapData` → `NormalizedQuote`). We are adding
Bebop as the 12th source via its **Aggregation API (JAM)**, on **both** Ethereum
(chainId 1) and Base (8453). Bebop returns self-execution calldata when
`gasless=false`, which maps onto our existing `NormalizedQuote.tx` model the
same way 0x/1inch do. Per ADR-010, Bebop is FEE-INCOMPATIBLE with the
FeeCollector; our fee is taken via Bebop's partner-fee params instead.

API facts (verified against docs, 2026-05-31):
- Endpoint: `GET https://api.bebop.xyz/jam/{slug}/v2/quote` where `{slug}` is the
  chain slug — our `getChainConfig(chainId).slug` already yields `ethereum` /
  `base`, which match Bebop's enum exactly.
- Auth (server-only): query `source={BEBOP_SOURCE}` + header `source-auth: {BEBOP_API_KEY}`.
  Without a key the API returns widened demo-mode quotes (dev only).
- Key request params: `sell_tokens`, `buy_tokens`, `sell_amounts`,
  `taker_address` (REQUIRED), `receiver_address`, `gasless=false`, `slippage`,
  `approval_type=Standard`, `source`, `fee` (bps), `fee_recipient`.
- Response: `buyTokens[<addr>].amount` (output), `.minimumAmount`,
  `tx { to, value, data, gas }`, `settlementAddress`, `approvalTarget`,
  `expiry`, `priceImpact`, `gasFee.usd`. `tx.value` is hex (e.g. `0x0`).
- JAM contracts (identical on all supported EVM chains except zkSync, so the
  same on 1 and 8453): settlement `0xbeb0b0623f66bE8cE162EbDfA2ec543A522F4ea6`,
  Balance Manager (approvalTarget) `0xC5a350853E4e36b73EB0C24aaA4b8816C9A3579a`.

### Objective
Add a `bebop` source that returns competitive quotes and executable swap calldata
on chains 1 and 8453, wired into the existing meta-quote pipeline, fee model, and
router-whitelist security — with no behavioural change to the other 11 sources.

### Requirements
1. **constants.ts**
   - Add `bebop` to `AGGREGATOR_APIS` with `base: 'https://api.bebop.xyz'` and a
     server-only key getter: `get key() { return process.env.BEBOP_API_KEY || '' }`.
     Add `BEBOP_SOURCE` read via `process.env.BEBOP_SOURCE || ''`.
   - Add `'bebop'` to `FEE_INCOMPATIBLE_SOURCES` (and to `FEE_INCOMPATIBLE_BY_CHAIN`
     entries if any chain overrides exist), so the FeeCollector path is skipped.
2. **chains/adapter-urls.ts** — add a `case 'bebop'` returning the host only
   (`'https://api.bebop.xyz'`); the adapter builds `/jam/{slug}/v2/quote` itself
   using `getChainConfig(chainId).slug`.
3. **chains/routers.ts** — add `bebop` to `ROUTER_WHITELIST_BY_CHAIN` for BOTH
   `1` and `8453` using the JAM settlement address as the primary router, and add
   the Balance Manager as an additional trusted spender for those chains (extend
   `sharedSpenders` or add an explicit entry so `approvalTarget` is whitelisted).
4. **adapters/bebop.ts** (new) implementing `DEXAdapter`:
   - `fetchQuote`: build the JAM quote URL for `chainId`, `gasless=false`,
     `taker_address` = a placeholder constant (price-only; no wallet). Send
     `source` + `source-auth` header. Parse output from
     `buyTokens[dst].amount`; map `gasUsd` from `gasFee.usd`. Throw a clear
     `Bebop {status}` error on non-200 and when no `buyTokens` entry is present.
   - `fetchSwapData`: same call with the real `taker_address = from`,
     `receiver_address = recipient ?? from`, `slippage`, and our fee params
     `fee` (standard bps from constants) + `fee_recipient` (our fee wallet env).
     Return `tx { to: settlementAddress, data, value: hexToDecimalString(tx.value), gas }`.
   - **Security gate**: assert `resp.tx.to === resp.settlementAddress`, and that
     BOTH `resp.settlementAddress` and `resp.approvalTarget` are in
     `getRouterWhitelist(chainId)`. If not, throw — do not return a tx.
   - Thread `chainId` exactly like the other adapters (`= DEFAULT_CHAIN_ID` default).
5. **adapters/index.ts** — register `bebop` in `ADAPTER_REGISTRY`.
6. **api.ts** — the hardcoded per-source error array
   `['1inch','0x','Velora','Odos','KyberSwap','CoW','Uniswap V3','OpenOcean','SushiSwap','Balancer','Curve']`
   is positional and now wrong (11 vs 12). Replace it with a list derived from
   `ADAPTER_REGISTRY` order (or append `'Bebop'` in the exact registry position)
   so error attribution stays aligned. Fix any other hardcoded source counts.
7. **fetchApproveSpender** — ensure Bebop resolves its approval spender to the
   chain's Balance Manager (`approvalTarget`), not the settlement contract, and
   not the FeeCollector (it is fee-incompatible).
8. **.env.example** — add `BEBOP_API_KEY=`, `BEBOP_SOURCE=`, and the fee-recipient
   var if not already present. Document that they are server-only.

### Do NOT
- Do NOT use `NEXT_PUBLIC_` for the Bebop key/source (server-only; rule #7).
- Do NOT hardcode-trust the quote's `to`/`approvalTarget` without the whitelist
  assertion — fail closed on any address not in the static whitelist (rule #2/#9).
- Do NOT route Bebop through the FeeCollector or add it to the FeeCollector path.
- Do NOT change behaviour, ordering, or fee logic of the existing 11 sources.
- Do NOT enable Bebop swaps on any chain other than 1 and 8453.

### Files affected
- `src/lib/constants.ts`
- `src/lib/chains/adapter-urls.ts`
- `src/lib/chains/routers.ts`
- `src/lib/adapters/bebop.ts` (new)
- `src/lib/adapters/index.ts`
- `src/lib/api.ts`
- `.env.example`
- tests (see below)

### Expected output
- `bebop` appears in meta-quotes on chains 1 and 8453; selecting it yields valid,
  whitelist-validated swap calldata; fee is carried via Bebop partner-fee params.
- New tests: adapter quote/swap parsing (mocked), whitelist-gate rejection of a
  tampered `to`/`approvalTarget`, fee-incompatibility (FeeCollector path skipped),
  per-chain URL slug (1→ethereum, 8453→base), and the corrected api.ts error array.
- Append a `FEEDBACK.md` section per the Code Agent Feedback Convention (e.g. note
  if Bebop rejects a placeholder taker for price-only quotes).

### Quality criteria
- Existing-source behaviour byte-identical (test-guarded). All adapter calls
  thread `chainId`. CI green (lint, typecheck, test, audit). Signed commit.
  Reference the commit hash back in this packet.

---

## Status — Implemented ✅

- `bebop` is the 12th `ADAPTER_REGISTRY` source, chain-aware on Ethereum (1) +
  Base (8453) via JAM (`/jam/{slug}/v2/quote`, `gasless=false`). Fee-incompatible
  (added to `FEE_INCOMPATIBLE_SOURCES` + `FEE_INCOMPATIBLE_BY_CHAIN[8453]`); fee via
  partner-fee params on the swap. JAM settlement + Balance Manager whitelisted on
  1 + 8453; adapter fails closed on any non-whitelisted `to`/`approvalTarget`;
  `fetchApproveSpender('bebop')` → Balance Manager. Keys server-only
  (`BEBOP_API_KEY`/`BEBOP_SOURCE`). api.ts positional error array fixed (now
  `sourceNames`-attributed, 12-source-safe).
- TDD: 11 new tests (`bebop.test.ts`). Full suite green (1307). Typecheck + lint
  (0 errors). 5-agent adversarial review (security gate, fee model, key safety,
  existing-source parity): 0 confirmed findings. See `FEEDBACK.md` (incl. the
  placeholder-taker caveat to validate against the live API).
- Commit hash: reported with the atomic signed commit (self-referential, not inlined).
