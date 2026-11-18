/**
 * The EIP-712 `Order` schemas the client signs with (useOrderEngine), the server recovers with
 * (POST /api/orders) and hashes with (order-hash.ts). Re-exported unchanged from ./types, which is
 * still the import path for app code.
 *
 * [fix/orders-server-side-order-hash] Moved here verbatim from ./types so that plain-Node scripts
 * (`node scripts/orders/*.ts`, Node's type stripping) can load them: ./types declares enums, which
 * type stripping refuses. Keep this file free of imports and of non-erasable TypeScript.
 */

// ── EIP-712 types for signing (v2) ───────────────────────
export const ORDER_EIP712_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerDataHash', type: 'bytes32' },  // [C-01]
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
} as const

// ── EIP-712 types for signing (v3) [ADR-013 §1] ──────────
// Adds `maxSlippageBps` (uint16) right after minAmountOut — MUST mirror
// contracts/order-engine/TeraSwapOrderExecutorV3.sol's ORDER_TYPEHASH field-for-field
// (audit-approved SHA 954c415). A mismatch here would make recoverTypedDataAddress
// disagree with the contract's on-chain signer recovery — escalate as a P1 finding.
export const ORDER_V3_EIP712_TYPES = {
  Order: [
    { name: 'owner', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'maxSlippageBps', type: 'uint16' },  // [ADR-013 §1]
    { name: 'orderType', type: 'uint8' },
    { name: 'condition', type: 'uint8' },
    { name: 'targetPrice', type: 'uint256' },
    { name: 'priceFeed', type: 'address' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'router', type: 'address' },
    { name: 'routerDataHash', type: 'bytes32' },  // [C-01]
    { name: 'dcaInterval', type: 'uint256' },
    { name: 'dcaTotal', type: 'uint256' },
  ],
} as const
