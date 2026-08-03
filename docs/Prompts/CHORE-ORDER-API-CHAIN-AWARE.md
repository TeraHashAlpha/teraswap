# CHORE-ORDER-API-CHAIN-AWARE — derive order chainId from the signed order, not a server env

## Context
The create-order API (`src/app/api/orders/route.ts`) verifies the EIP-712 order signature against a domain
built from **`process.env.CHAIN_ID` (default `1`)**:

```js
const chainId = parseInt(process.env.CHAIN_ID || '1', 10)
const executorAddress = getOrderExecutor(chainId)
const domain = { ...EIP712_DOMAIN, chainId, verifyingContract: executorAddress }
const recovered = await recoverTypedDataAddress({ domain, types: ORDER_TYPES, primaryType: 'Order', message, signature })
if (recovered.toLowerCase() !== body.wallet.toLowerCase()) return 400 'Signature mismatch'
```

The frontend signs with **`getOrderExecutorDomain(connectedChainId)`** (e.g. Base → chainId 8453,
verifyingContract `0x135B339902Ea4E0fB4CF059961dc8856bA1D2598`). On the single multi-chain Vercel deployment,
a **Base** order (signed for 8453) is verified against the **mainnet** domain (1 + mainnet executor) →
recovered signer ≠ wallet → **"Signature mismatch"**. A server-global `CHAIN_ID` cannot represent a per-order
property once more than one chain has orders. (A `CHAIN_ID=8453` env is the stop-gap already applied; this
prompt removes the assumption.)

## Objective
Make order signature verification **per-order chain-aware**, and make the backend reuse the **exact same
domain builder** the frontend signs with, so the two can never drift.

## Requirements
1. **Derive chainId from the signed order, not the server env.** Read `body.chainId` (the chain the wallet
   was on when signing). Validate it's an integer and a supported chain.
2. **Reuse `getOrderExecutorDomain(body.chainId)`** to build the verification domain — the SAME function the
   frontend uses — instead of hand-assembling `{ ...EIP712_DOMAIN, chainId, verifyingContract }`. This
   guarantees byte-identical name/version/chainId/verifyingContract on both sides.
3. **Fail-closed for unsupported chains:** if `getOrderExecutor(body.chainId)` is null / the domain builder
   has no entry for that chain → `400 { error: 'Conditional orders are not available on chain <id>' }`
   BEFORE verification (don't verify against a wrong/absent contract).
4. **Frontend parity:** confirm the frontend POSTs `chainId` (the connected chainId used for
   `getOrderExecutorDomain`) in the order body. If it doesn't, add it. The chainId sent MUST equal the one
   used to sign — add a guard/test.
5. **Persist + scope by chain:** store the order's `chainId` on the Supabase `orders` row. Scope the keeper's
   query so a keeper for chain X only picks orders for chain X (the Base keeper currently queries
   `orders?status=eq.active` with **no chain filter** — fine while Base-only, unsafe once mainnet/other chains
   have orders). Add the column + index if missing (migration), and add `&chainId=eq.<CHAIN_ID>` to the
   keeper's REST query. The keeper's own `CHAIN_ID` stays its execution chain.
6. **Mainnet byte-identical:** `getOrderExecutorDomain(1)` and the mainnet verification path must be unchanged
   (the existing `getOrderExecutorDomain(1) is UNCHANGED` test must still pass).

## Security notes
- Deriving chainId from `body` is safe: chainId is part of the signed EIP-712 domain, so a forged/mismatched
  `body.chainId` simply fails recovery (can't be forged). `executorAddress` is resolved server-side from an
  allowlist (`getOrderExecutor`), never from the body — no address injection.
- Keep `routerDataHash` [C-01] and all other message fields exactly as today.

## Do NOT
- Don't change the Solidity contract, the EIP-712 `ORDER_TYPES`, or the domain `name`/`version`.
- Don't break mainnet (byte-identical) or swaps (separate path).
- Don't read `process.env.CHAIN_ID` for signature verification anymore (it may remain only as a default/legacy
  fallback for a single-chain deploy, but the order's own chainId takes precedence).

## Files affected (verify on `main`)
- `src/app/api/orders/route.ts` (and `src/app/api/orders/[id]/route.ts` if it rebuilds a domain)
- the order-signing hook(s) that POST the order (`useOrderEngine.ts` / `useSwap.ts`) — for chainId parity
- `src/lib/order-engine/config.ts` (`getOrderExecutorDomain`, `getOrderExecutor`) — reuse, don't duplicate
- Supabase `orders` schema + the keeper query in `contracts/order-engine/executor/executor.js`

## Expected output
- Branch `chore/order-api-chain-aware` off latest `origin/main`; signed commits; CI green.
- Tests: a Base order (chainId 8453) verifies against the Base domain ✅; a mainnet order against mainnet ✅;
  an unsupported chain → 400 ✅; a body.chainId ≠ signing chainId → `Signature mismatch` ✅; keeper query
  scoped by chainId ✅. Reintroducing the env-based chainId must make the Base test RED.
- FEEDBACK with anything adjacent discovered (e.g. other call sites reading `process.env.CHAIN_ID` for order
  logic). No Auditor for the config stop-gap; this code change SHOULD get an Auditor pass (touches fund-flow
  signature verification).

## Quality criteria
Frontend and backend produce byte-identical EIP-712 domains for every supported chain via a single shared
builder; no server-global chain assumption remains in the order path; mainnet unchanged; fail-closed on
unsupported chains.
