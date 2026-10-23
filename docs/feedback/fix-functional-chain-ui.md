# Feedback — fix/functional-chain-ui (base origin/main 96005c4)

Display/plumbing only. Source rows: `site-claims-bugs-2026-10-12.md` F1–F4, C8; C9 from the goal.

## Checklist
- [x] C1 F1 footer follows the selected chain
- [x] C2 F2 KyberSwap route names · F3 gas USD-first
- [ ] C3 F4 Analytics pairs metric + volume trend order
- [ ] C4 C8 logo + DefiLlama proxies, CSP hosts removed
- [ ] C5 C9 meta description
- [ ] Verify: suite vs main, lint delta 0, tsc, diff --stat, push

## Owner answers (2026-10-23, supersede the goal text)
- F1: Footer had no explorer/chain name/contract → add `<Chain> · Block #N` linked to `<explorer>/block/N`.
- F3: `fmtGas` already at QuoteBreakdown:482 (#586) → USD first + the two test cases only.
- C9: "Absolute protection"/"MEV-free" already gone (#587) → change only "to find the best swap rate".
- C8: drop the DefiLlama mention from `PRIVACY_DIRECT_NOTE` (logos stay: catalog logoURI / CoinGecko 302).

Reads outside the list (recorded): `src/lib/chains/{registry,types,tokens,index}.ts` (explorer/name), `src/lib/format.ts` (fmtGas).

## Evidence
1. F1 — `Footer.test.tsx` "Footer follows the selected chain": selector 8453/no wallet → `useBlockNumber` mock
   last called with `chainId: 8453`, link `https://basescan.org/block/12345678`; set 42161 → `chainId: 42161`,
   `https://arbiscan.io/…`; wallet 42161 beats selector 8453; nothing selected → 1/etherscan. 4/4 red on old Footer.
2. F2 — fixture recorded 2026-10-23 (`__fixtures__/kyberswap-routes-mainnet.ts`, WETH→USDC mainnet). Hop shape:
   `{pool, tokenIn, tokenOut, swapAmount, amountOut, exchange, poolType, extra, poolExtra}`. Label = `exchange`
   → `poolType` → 'KyberSwap', refusing any embedded 0x address. Before `0xe0554a476a092703abdb3ef35c80e0d76d32939f`
   → after `uniswapv3`. Applied to fetchQuote AND fetchSwapData (both mapped `r.pool`). QuoteBreakdown guard
   falls back to `sourceLabel(source)` (= 'KyberSwap' for Kyber; correct name if another source ever emits an address).
3. F3 — "Est. gas" row: 0.0000012/$0.0036 → `<$0.01 (~0.0000012 ETH)`; 0.0031/$9.30 → `$9.30 (~0.0031 ETH)`;
   usd 0 → `~0.0031 ETH`.
