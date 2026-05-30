/**
 * [FULL-H-02] Client-side spender allowlist.
 *
 * The ERC-20 approval spender address comes from /api/spender. The server
 * returns only trusted constants, but the client trusts the response
 * verbatim before prompting the user to sign `approve(spender, amount)`.
 * If that endpoint — or anything upstream of it — is compromised or MITM'd,
 * the user could be tricked into approving `transferFrom` to an attacker.
 *
 * This allowlist is the client-side guard: every spender must already be a
 * router/contract we knowingly route through. It is built from the SAME
 * source of truth that validateRouterAddress uses for swap targets
 * (ROUTER_WHITELIST in api.ts) plus the FeeCollector V1/V2, Permit2 and the
 * CoW vault relayer — never hardcoded string literals.
 *
 * Permit2 is intentionally included: it is a legitimate spender for
 * permit-based approvals (the 0x source approves Permit2).
 */
import { ROUTER_WHITELIST } from '@/lib/api'
import { getRouterWhitelist } from '@/lib/chains/routers'
import { DEFAULT_CHAIN_ID } from '@/lib/chains/registry'
import {
  FEE_COLLECTOR_ADDRESS,
  FEE_COLLECTOR_V1_ADDRESS,
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
} from '@/lib/constants'

export const TRUSTED_SPENDER_ADDRESSES: ReadonlySet<string> = new Set<string>(
  [
    // All whitelisted swap routers + FeeCollector V2 (ROUTER_WHITELIST already
    // contains every spender fetchApproveSpender() can return).
    ...ROUTER_WHITELIST,
    FEE_COLLECTOR_ADDRESS,
    FEE_COLLECTOR_V1_ADDRESS,
    PERMIT2_ADDRESS,
    COW_VAULT_RELAYER,
  ]
    .filter(Boolean)
    .map((a) => a.toLowerCase()),
)

/**
 * True when `address` is a known, trusted ERC-20 approval spender on `chainId`.
 * [P222] Mainnet uses the existing TRUSTED_SPENDER_ADDRESSES set verbatim
 * (byte-identical). Other chains derive their trusted spenders from the
 * per-chain router whitelist (which already includes that chain's Permit2,
 * CoW VaultRelayer, and FeeCollector).
 */
export function isTrustedSpender(address: string, chainId: number = DEFAULT_CHAIN_ID): boolean {
  const lower = address.toLowerCase()
  if (chainId === DEFAULT_CHAIN_ID) {
    return TRUSTED_SPENDER_ADDRESSES.has(lower)
  }
  return getRouterWhitelist(chainId).includes(lower)
}
