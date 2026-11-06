/**
 * [fix/user-ip-privacy] Per-chain READ-ONLY method allow-list for the /api/rpc proxy.
 *
 * The proxy used to relay every JSON-RPC method except a short blacklist of signing methods. That was
 * tolerable while it only carried mainnet reads; it now carries EVERY browser read on all three chains
 * on a paid upstream key that no visitor can see, so what it relays is decided here, by name, per chain.
 * A method that is not listed is refused with 403 before anything reaches the upstream.
 *
 * What is listed: the reads this app's wagmi/viem surface makes (balances, eth_call / Multicall3,
 * receipts, blocks, fee data, logs, code, storage, proofs) and the handful of plain reads a
 * WalletConnect-connected wallet relays through the same URL (wagmi hands the provider our proxy URL as
 * its rpcMap). What is NOT listed, on any chain: anything that signs or broadcasts (`eth_send*`,
 * `eth_sign*`, `personal_*`, `wallet_*`), node-side filters and subscriptions (`eth_newFilter`,
 * `eth_getFilter*`, `eth_subscribe` — the app has no filter-based watcher, and a filter read would
 * bypass the eth_getLogs range clamp), and the archive namespaces (`debug_*`, `trace_*`).
 *
 * Per chain on purpose: the map is keyed by chain id and `rpc-method-policy.test.ts` fails when the
 * chain registry lists a chain with no entry here, so adding a chain forces this decision instead of
 * inheriting another chain's list.
 */

/** Reads relayed on every supported chain. */
const COMMON_READ_METHODS = [
  // identity / node
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_syncing',
  // head
  'eth_blockNumber',
  // execution (no state change)
  'eth_call',
  'eth_estimateGas',
  'eth_createAccessList',
  'eth_simulateV1',
  // fees
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  // account state
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getProof',
  // blocks
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash',
  // transactions
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionReceipt',
  // logs (range clamped by rpc-cost-policy.ts)
  'eth_getLogs',
] as const

/** Ethereum only: the EIP-4844 blob fee market is an L1 concept; no L2 read in this app needs it. */
const MAINNET_ONLY_READ_METHODS = ['eth_blobBaseFee'] as const

const ALLOWED_BY_CHAIN: ReadonlyMap<number, ReadonlySet<string>> = new Map<number, ReadonlySet<string>>([
  [1, new Set<string>([...COMMON_READ_METHODS, ...MAINNET_ONLY_READ_METHODS])],
  [8453, new Set<string>(COMMON_READ_METHODS)],
  [42161, new Set<string>(COMMON_READ_METHODS)],
])

/** Chains that have an allow-list (must equal the chain registry — pinned by the test). */
export const RPC_POLICY_CHAIN_IDS: readonly number[] = [...ALLOWED_BY_CHAIN.keys()]

/** True when `method` is a read the proxy relays on `chainId`. Unknown chain or non-string method: false. */
export function isAllowedReadMethod(chainId: number, method: unknown): boolean {
  if (typeof method !== 'string') return false
  return ALLOWED_BY_CHAIN.get(chainId)?.has(method) ?? false
}

/** The allow-list for `chainId`, sorted (empty for an unknown chain). For tests and docs. */
export function allowedReadMethods(chainId: number): readonly string[] {
  return [...(ALLOWED_BY_CHAIN.get(chainId) ?? [])].sort()
}
