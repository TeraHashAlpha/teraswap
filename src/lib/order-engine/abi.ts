/**
 * TeraSwapOrderExecutor v2 — ABI (subset for frontend)
 *
 * Only includes the functions/events the UI needs:
 * - canExecute, executeOrder, cancelOrder, getOrderHash, getNonce
 * - domainSeparator, ORDER_TYPEHASH, FEE_BPS, MIN_ORDER_AMOUNT
 * - nonces, invalidatedNonces, dcaExecutions
 * - OrderExecuted, OrderCancelled events
 */

export const ORDER_EXECUTOR_ABI = [
  // ── View functions ──
  {
    inputs: [
      { components: [
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
        { name: 'routerDataHash', type: 'bytes32' },  // [C-05] Must match contract Order struct
        { name: 'dcaInterval', type: 'uint256' },
        { name: 'dcaTotal', type: 'uint256' },
      ], name: 'order', type: 'tuple' },
      { name: 'signature', type: 'bytes' },
    ],
    name: 'canExecute',
    outputs: [
      { name: '', type: 'bool' },
      { name: '', type: 'string' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { components: [
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
        { name: 'routerDataHash', type: 'bytes32' },  // [C-05] Must match contract Order struct
        { name: 'dcaInterval', type: 'uint256' },
        { name: 'dcaTotal', type: 'uint256' },
      ], name: 'order', type: 'tuple' },
    ],
    name: 'getOrderHash',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'getNonce',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'nonces',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'invalidatedNonces',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'bytes32' }],
    name: 'dcaExecutions',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'bytes32' }],
    name: 'cancelledOrders',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'domainSeparator',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'ORDER_TYPEHASH',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'FEE_BPS',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'MIN_ORDER_AMOUNT',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  // [Audit] Pause state check
  {
    inputs: [],
    name: 'paused',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // ── Write functions ──
  {
    inputs: [
      { components: [
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
        { name: 'routerDataHash', type: 'bytes32' },  // [C-05] Must match contract Order struct
        { name: 'dcaInterval', type: 'uint256' },
        { name: 'dcaTotal', type: 'uint256' },
      ], name: 'order', type: 'tuple' },
    ],
    name: 'cancelOrder',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'newNonce', type: 'uint256' }],
    name: 'invalidateNonces',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // ── Events ──
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'orderHash', type: 'bytes32' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: true, name: 'orderType', type: 'uint8' },
      { indexed: false, name: 'tokenIn', type: 'address' },
      { indexed: false, name: 'tokenOut', type: 'address' },
      { indexed: false, name: 'amountIn', type: 'uint256' },
      { indexed: false, name: 'amountOut', type: 'uint256' },
      { indexed: false, name: 'fee', type: 'uint256' },
    ],
    name: 'OrderExecuted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'orderHash', type: 'bytes32' },
      { indexed: true, name: 'owner', type: 'address' },
    ],
    name: 'OrderCancelled',
    type: 'event',
  },
] as const
