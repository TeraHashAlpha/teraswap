// executor-routing.js — dual-executor (v2/v3) selection for a single order (pure, unit-tested).
//
// [SPRINT-V3-P2 / ADR-013 §1] v3 is a NEW, separately-deployed contract per chain (v2 is not
// upgradeable). A v3-signed order is distinguished by carrying `maxSlippageBps` in its
// `order_data` JSON (the frontend only sets it once the signing chain has a v3 executor
// configured — see src/lib/order-engine/config.ts::getOrderExecutorV3). This module decides,
// PER ORDER, which contract address + ABI the keeper must call — never falling back from v3 to
// v2 (wrong typehash) and never silently executing a v3 order against v2.
//
// Pure + never-throwing (mirrors order-floor.js / submission-policy.js): no I/O, no env reads —
// the caller passes in the resolved v2/v3 address+ABI it already has at module scope.

/**
 * @param {object} p
 * @param {Record<string, unknown>} p.orderData  the order's `order_data` JSON blob
 * @param {string} p.v2Address
 * @param {unknown} p.v2Abi
 * @param {string} p.v3Address  empty string / falsy = v3 not configured on this keeper's chain
 * @param {unknown} p.v3Abi
 * @returns {{ ok: boolean, isV3: boolean, execAddress: string|null, execAbi: unknown|null, reason: string }}
 *   ok=false ⇒ SKIP this order this cycle (caller must leave it 'active', never execute it).
 */
export function resolveExecutorRouting({ orderData, v2Address, v2Abi, v3Address, v3Abi }) {
  const od = orderData || {}
  const isV3 = od.maxSlippageBps !== undefined && od.maxSlippageBps !== null

  if (!isV3) {
    return { ok: true, isV3: false, execAddress: v2Address, execAbi: v2Abi, reason: "v2 order" }
  }

  if (!v3Address) {
    return {
      ok: false,
      isV3: true,
      execAddress: null,
      execAbi: null,
      reason: "v3 order but no V3_CONTRACT_ADDRESS configured for this keeper's chain — skipping, never mis-routed to v2",
    }
  }

  return { ok: true, isV3: true, execAddress: v3Address, execAbi: v3Abi, reason: "v3 order, v3 executor configured" }
}
