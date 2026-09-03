## Feedback — fix/zerox-price-endpoint

### Doc citations

**`taker` requirement:**
- `/quote` (firm, signable quote) — `taker` is **required**.
  - https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getquote
  - https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getquote
- `/price` (indicative quote) — `taker` is **optional**.
  - https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getprice
  - https://docs.0x.org/api-reference/evm-ap-is/swap/allowanceholder-getprice

**`chainId` requirement:** **Required on every v2 call** — `/price` and `/quote`,
both the permit2 and allowance-holder variants, all four reference pages above
list `chainId` as required with no stated mainnet default. The old `[P217]`
comment ("0x v2 defaults to mainnet when chainId is omitted") is **wrong**; both
`fetchQuote` and `fetchSwapData` now send `chainId` unconditionally, mainnet
included.

### Request URLs now built (key header name only, never a value)

Header sent on every request: `0x-api-key: <ZEROX_API_KEY>` (plus `0x-version: v2`).

- `fetchQuote`, mainnet (chainId=1):
  `GET {base}/swap/permit2/price?sellToken=...&buyToken=...&sellAmount=...&chainId=1&swapFeeRecipient=...&swapFeeBps=10&swapFeeToken=...`
- `fetchQuote`, Base (chainId=8453):
  `GET {base}/swap/allowance-holder/price?sellToken=...&buyToken=...&sellAmount=...&chainId=8453&swapFeeRecipient=...&swapFeeBps=10&swapFeeToken=...`
- `fetchSwapData`, mainnet (chainId=1):
  `GET {base}/swap/permit2/quote?sellToken=...&buyToken=...&sellAmount=...&taker=...&slippageBps=...&chainId=1&swapFeeRecipient=...&swapFeeBps=10&swapFeeToken=...`
- `fetchSwapData`, Base (chainId=8453):
  `GET {base}/swap/allowance-holder/quote?sellToken=...&buyToken=...&sellAmount=...&taker=...&slippageBps=...&chainId=8453&swapFeeRecipient=...&swapFeeBps=10&swapFeeToken=...`

(`{base}` = `getAdapterApiUrl('0x', chainId)`, unchanged by this fix.)

### Response mapping

`/price`'s documented example response
(https://docs.0x.org/api-reference/evm-ap-is/swap/permit-2-getprice) has **no
`transaction` object** (no signable tx for an indicative quote) — the gas
estimate lives at the top-level `gas` field instead of `transaction.gas`.
`buyAmount` and `route.fills[].source` are present under the same keys as
`/quote`. The existing mapping (`Number(data.transaction?.gas || data.gas ||
0)`) already falls through to `data.gas` when `transaction` is absent, so no
code change was needed there — but it was previously untested against a
`/price`-shaped response, so `estimatedGas` could have silently landed on the
`|| 0` fallback undetected. Added a fixture test
(`src/lib/adapters/zerox.test.ts`, "0x /price response mapping") built from the
docs' own example shape (with its `null` placeholders filled with
representative values) asserting `estimatedGas` reads the real `150000` from
`gas`, not `0`.

### Acceptance results

1. **Endpoint/taker test** — `zerox.test.ts` "0x fetchQuote uses the indicative
   /price endpoint" + "0x fetchSwapData keeps /quote WITH taker": quote hits
   `/swap/permit2/price` (mainnet) / `/swap/allowance-holder/price` (8453)
   without `taker`; swap-build hits `/quote` WITH `taker`, both chains.
   Negative control asserts the fetchQuote URL never matches
   `/swap/(permit2|allowance-holder)/quote` — the old broken shape. PASS.
2. **chainId + fee params** — every URL assertion above includes `chainId=1`
   or `chainId=8453` on both `/price` and `/quote` (was previously omitted on
   mainnet); `swapFeeRecipient`/`swapFeeBps`/`swapFeeToken` assertions kept
   from the existing SPRINT-9T T1 suite, now also verified present on
   `/price`. PASS.
3. **`/price` response mapping fixture** — see above, built from 0x's own
   documented example. PASS.
4. **Full suite / lint / typecheck** — 254 test files / 3623 tests pass
   (`npx vitest run`); `npx tsc --noEmit` clean; `npx eslint` clean on both
   changed files. PASS.

### Verification note
I have no `ZEROX_API_KEY` and did not call the live 0x API — all of the above
is verified against 0x's public v2 reference docs and this repo's mocked test
suite, per the task's constraints. **The real verification is the production
circuit breaker**: it was cycling `[CB] 0x: HALF_OPEN → OPEN (test failed) —
HttpError 400` on every probe (09:41–09:51 UTC 2026-09-03) because `fetchQuote`
called `/quote` without `taker`. Once this fix is deployed, that should stop —
confirm by watching for the breaker closing (no more `HttpError 400` /
`HALF_OPEN → OPEN` cycles for the `0x` source) after deploy.
