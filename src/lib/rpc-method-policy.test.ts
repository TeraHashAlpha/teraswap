// @vitest-environment node
/**
 * [fix/user-ip-privacy] The /api/rpc per-chain read allow-list.
 */
import { describe, it, expect } from 'vitest'
import { getSupportedChainIds } from '@/lib/chains/registry'
import { allowedReadMethods, isAllowedReadMethod, RPC_POLICY_CHAIN_IDS } from './rpc-method-policy'

const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)

describe('rpc-method-policy — one list per registry chain', () => {
  it('has an allow-list for exactly the chains the registry supports (a new chain must decide its own)', () => {
    expect(sorted(RPC_POLICY_CHAIN_IDS)).toEqual(sorted(getSupportedChainIds()))
  })

  it('an unknown chain allows nothing', () => {
    expect(allowedReadMethods(10)).toEqual([])
    expect(isAllowedReadMethod(10, 'eth_call')).toBe(false)
  })

  it.each([1, 8453, 42161])('chain %i relays the reads the app makes', (chainId) => {
    for (const m of [
      'eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice',
      'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getTransactionReceipt',
      'eth_getTransactionByHash', 'eth_getCode', 'eth_getTransactionCount', 'net_version',
    ]) {
      expect([m, isAllowedReadMethod(chainId, m)]).toEqual([m, true])
    }
  })

  // [fix/user-ip-privacy A76 S-3] No browser path sends these, and each lets the caller size the work or the answer
  // (the audit pulled 12 MB of eth_getLogs through a tag range). Off every chain's list.
  it.each([1, 8453, 42161])('chain %i does NOT relay eth_getLogs, eth_simulateV1, eth_getProof, eth_createAccessList', (chainId) => {
    for (const m of ['eth_getLogs', 'eth_simulateV1', 'eth_getProof', 'eth_createAccessList']) {
      expect([m, isAllowedReadMethod(chainId, m)]).toEqual([m, false])
    }
    expect(allowedReadMethods(chainId).filter((m) => /logs|simulate|proof|accesslist/i.test(m))).toEqual([])
  })
})

describe('rpc-method-policy — read-only by construction', () => {
  // Any method whose NAME says it writes, signs, mutates node state or opens a server-side handle.
  const NOT_A_READ = /^(eth_send|eth_sign|eth_submit|eth_new|eth_uninstall|eth_subscribe|eth_unsubscribe|eth_accounts|eth_requestAccounts|eth_coinbase|eth_mining|eth_getFilter|personal_|wallet_|debug_|trace_|admin_|miner_|txpool_|engine_|anvil_|hardhat_|evm_)/

  it.each([1, 8453, 42161])('chain %i lists no signing, broadcast, filter, subscription or node-admin method', (chainId) => {
    const list = allowedReadMethods(chainId)
    expect(list.length).toBeGreaterThan(20)
    expect(list.filter((m) => NOT_A_READ.test(m))).toEqual([])
  })

  it.each([1, 8453, 42161])('chain %i lists only eth_* reads plus net_version / web3_clientVersion', (chainId) => {
    const other = allowedReadMethods(chainId).filter((m) => !m.startsWith('eth_'))
    expect(other.sort()).toEqual(['net_version', 'web3_clientVersion'])
  })

  it('matches exactly: no prefix, case or whitespace variant slips through', () => {
    for (const m of ['ETH_CALL', 'eth_call ', ' eth_call', 'eth_callX', 'eth_cal', 'eth_call\n', '']) {
      expect([m, isAllowedReadMethod(1, m)]).toEqual([m, false])
    }
  })

  it('a non-string method is never allowed (no prototype lookup, no coercion)', () => {
    for (const m of [undefined, null, 1, {}, ['eth_call'], { toString: () => 'eth_call' }]) {
      expect(isAllowedReadMethod(1, m)).toBe(false)
    }
    for (const m of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(isAllowedReadMethod(1, m)).toBe(false)
    }
  })
})

describe('rpc-method-policy — per chain, not one shared list', () => {
  it('Base and Arbitrum share the common reads; Ethereum adds only the L1 blob fee read', () => {
    expect(allowedReadMethods(8453)).toEqual(allowedReadMethods(42161))
    const extra = allowedReadMethods(1).filter((m) => !allowedReadMethods(8453).includes(m))
    expect(extra).toEqual(['eth_blobBaseFee'])
    expect(allowedReadMethods(8453).filter((m) => !allowedReadMethods(1).includes(m))).toEqual([])
  })
})
