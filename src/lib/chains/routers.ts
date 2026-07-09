/**
 * [P222 / ADR-009] Per-chain DEX router whitelist.
 *
 * The swap target / ERC-20 approval spender for each aggregator, per chain.
 * Used to (a) validate a swap's tx.to is a known router and (b) gate which
 * addresses a user may approve. Base addresses were researched + verified on
 * Basescan / each protocol's official source (see the per-line comments).
 *
 * This module is self-contained (imports only constants + the registry) so
 * api.ts can delegate to it for non-mainnet chains without a circular import.
 * Mainnet validation in api.ts continues to use its own ROUTER_WHITELIST set
 * unchanged; getRouterWhitelist(1) here mirrors it exactly (test-guarded).
 */
import {
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
  COW_SETTLEMENT,
  ODOS_ROUTER_V3,
  UNISWAP_SWAP_ROUTER_02,
  FEE_COLLECTOR_ADDRESS,
  BEBOP_JAM_SETTLEMENT,
  BEBOP_BALANCE_MANAGER,
} from '@/lib/constants'
import { getChainConfig, DEFAULT_CHAIN_ID } from './registry'

/**
 * Primary router (the address an aggregator's API returns as the swap target
 * and that users approve) per source, per chain. Base addresses verified via
 * Basescan + official docs/APIs (research run wf_4a01469a-7f6, all high
 * confidence).
 */
export const ROUTER_WHITELIST_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
  1: {
    '1inch': '0x111111125421cA6dc452d289314280a0f8842A65', // AggregationRouterV6
    '0x': '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',     // Exchange Proxy (v1)
    velora: '0x6A000F20005980200259B80c5102003040001068',   // Augustus V6
    odos: '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559',       // Odos Router V2
    kyberswap: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',  // MetaAggregationRouterV2
    cowswap: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',    // VaultRelayer
    openocean: '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64',  // Exchange proxy
    sushiswap: '0x46B3fDF7b5CDe91Ac049936bF0bDb12c5d22202e',  // RouteProcessor4
    balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',   // Vault V2
    uniswapv3: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // SwapRouter02
    curve: '0x16C6521Dff6baB339122a0FE25a9116693265353',      // CurveRouterNG
    bebop: BEBOP_JAM_SETTLEMENT,                                // [ADR-010] JamSettlement (tx.to)
  },
  // ── Base (8453) — verified on Basescan / official sources, May 2026 ──
  8453: {
    // AggregationRouterV6 — same deterministic address as mainnet (Basescan: "1inch: Aggregation Router V6", exact-match verified)
    '1inch': '0x111111125421cA6dc452d289314280a0f8842A65',
    // 0x v2 AllowanceHolder (Cancun chains) — Basescan: "0x: Allowance Holder". The mainnet v1 Exchange Proxy does NOT exist on Base. Confirm allowanceTarget per-quote at runtime.
    '0x': '0x0000000000001fF3684f28c67538d4D072C22734',
    // Velora/ParaSwap Augustus V6.2 — same canonical address as mainnet (Basescan: "Velora: Augustus V6.2"; live price API version=6.2)
    velora: '0x6A000F20005980200259B80c5102003040001068',
    // Odos Router V2 on Base (api.odos.xyz/info/router/v2/8453; Basescan: "Odos: Router V2") — version-matched to the mainnet V2 entry
    odos: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1',
    // KyberSwap MetaAggregationRouterV2 — same address as mainnet
    kyberswap: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    // CoW VaultRelayer — same address on every CoW chain
    cowswap: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    // OpenOcean Exchange — same address as mainnet
    openocean: '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64',
    // SushiSwap RedSnwapper — Sushi v7 API tx.to on Base (Basescan: "SushiSwap: RedSnwapper")
    sushiswap: '0xAC4c6e212A361c968F1725b4d055b47E63F80b75',
    // Balancer V2 Vault — canonical CREATE2 address, same as mainnet (balancer-deployments base.json)
    balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    // Uniswap SwapRouter02 on Base (Uniswap docs base-deployments; Basescan: "Uniswap V3: Swap Router02")
    uniswapv3: '0x2626664c2603336E57B271c5C0b26F421741e481',
    // Curve CurveRouterNG v1.1 on Base (curve-router-ng README; Basescan: "Curve.fi: Router")
    curve: '0x4f37A9d177470499A2dD084621020b023fcffc1F',
    // [ADR-010] Bebop JamSettlement (tx.to) — same address on every EVM chain.
    bebop: BEBOP_JAM_SETTLEMENT,
  },
  // ── Arbitrum One (42161) [SPRINT-46-ARBITRUM-CONFIG] — CONFIG-ONLY, dark launch. Every address
  // sourced verbatim from docs/Reports/ARBITRUM-READINESS.md. Inert while contracts.feeCollector
  // is null (this whitelist is only consulted on an ACTIVE chain's swap path) — see registry.ts.
  42161: {
    // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] AggregationRouterV6 — RE-VERIFIED (was assumed): confirmed
    // on-chain (48,590 B) and bytecode-diffed vs the mainnet deployment at the same address — 98.35%
    // identical, only diff is the embedded native-WETH constant. See ARBITRUM-ROUTER-VERIFICATION.md.
    '1inch': '0x111111125421cA6dc452d289314280a0f8842A65',
    // 0x v2 AllowanceHolder — report-verified, same address as Base.
    '0x': '0x0000000000001fF3684f28c67538d4D072C22734',
    // Velora/ParaSwap Augustus V6.2 — report-verified on-chain, canonical cross-chain address.
    velora: '0x6A000F20005980200259B80c5102003040001068',
    // Odos Router V2 on Arbitrum — report-verified.
    odos: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1',
    // KyberSwap MetaAggregationRouterV2 — report: "same as mainnet (deterministic)".
    kyberswap: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
    // CoW VaultRelayer — cross-chain deterministic, report-verified.
    cowswap: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
    // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] OpenOcean Exchange — RE-VERIFIED (was assumed): a live
    // POST to open-api.openocean.finance/v4/42161/swap returned this EXACT address as tx.to — direct
    // evidence from the adapter's real execution path. See ARBITRUM-ROUTER-VERIFICATION.md.
    openocean: '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64',
    // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] SushiSwap: the report's assumed "RouteProcessor5" address
    // has NO CODE on Arbitrum (eth_getCode → empty). Sushi's live api.sushi.com/swap/v7/42161 returns
    // this address (RedSnwapper) as tx.to — same address already configured for Base — confirmed
    // deployed (9,958 B). See docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md.
    sushiswap: '0xAC4c6e212A361c968F1725b4d055b47E63F80b75',
    // Balancer V2 Vault — same canonical CREATE2 address as mainnet/Base (report body). Globally
    // disabled via DISABLED_SOURCES.balancer regardless of chain (W7-L-02) — see FEEDBACK.
    balancer: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Uniswap SwapRouter02 — the report's value
    // (0xE592427A…) is the ORIGINAL SwapRouter (V1), a different contract (confirmed: 24,142 B vs
    // SwapRouter02's 48,996 B). Our adapter's calldata (multicall(deadline, data) wrapping a
    // deadline-less exactInputSingle params tuple) is the SwapRouter02 calling convention. Corrected
    // to the same address as mainnet (part of Uniswap's original synchronized multi-chain deploy).
    // See docs/Reports/ARBITRUM-ROUTER-VERIFICATION.md.
    uniswapv3: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    // [SPRINT-47-ARBITRUM-ACTIVATION-PREP] Curve stableswap router — the report's value has NO CODE
    // on Arbitrum (eth_getCode → empty); no verified official replacement found this pass (flagged,
    // not guessed — see the report). Inert either way: the curve adapter is mainnet-only fail-closed
    // today (fetchQuote returns null off chainId 1) — see curve.ts.
    curve: '0xf0d4C12e3C5589b1de35eaF85B163Cc23827e854',
    // [ADR-010] Bebop JamSettlement (tx.to) — same address on every EVM chain.
    bebop: BEBOP_JAM_SETTLEMENT,
  },
}

// [ADR-010] Bebop JAM trusted spenders for the chains where Bebop is enabled
// (1 + 8453). Same addresses on both. The settlement is the swap target (tx.to);
// the Balance Manager is the ERC-20 approval spender (approvalTarget). Both must
// be in the whitelist so the adapter's fail-closed gate accepts a genuine quote.
const BEBOP_SPENDERS_BY_CHAIN: Record<number, string[]> = {
  1: [BEBOP_JAM_SETTLEMENT.toLowerCase(), BEBOP_BALANCE_MANAGER.toLowerCase()],
  8453: [BEBOP_JAM_SETTLEMENT.toLowerCase(), BEBOP_BALANCE_MANAGER.toLowerCase()],
  // [SPRINT-46-ARBITRUM-CONFIG] Report: JAM settlement is "deterministic, same on all chains" —
  // the Balance Manager follows the same cross-chain deploy pattern. Inert while 42161 is dark.
  42161: [BEBOP_JAM_SETTLEMENT.toLowerCase(), BEBOP_BALANCE_MANAGER.toLowerCase()],
}

/**
 * Full mainnet (chainId 1) whitelist — mirrors ROUTER_WHITELIST in api.ts
 * EXACTLY (primary routers + legacy versions + Permit2 + CoW settlement +
 * FeeCollector). A test pins this equality so the two can't drift. Lowercased.
 */
const MAINNET_FULL: string[] = [
  PERMIT2_ADDRESS,
  COW_VAULT_RELAYER,
  COW_SETTLEMENT,
  ODOS_ROUTER_V3,
  UNISWAP_SWAP_ROUTER_02,
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap Aggregator Router
  '0x6352a56caadc4f1e25cd6c75970fa768a3304e64', // OpenOcean Exchange Proxy
  '0x46b3fdf7b5cde91ac049936bf0bdb12c5d22202e', // SushiSwap RouteProcessor4
  '0xba12222222228d8ba445958a75a0704d566bf2c8', // Balancer Vault V2
  '0x111111125421ca6dc452d289314280a0f8842a65', // 1inch AggregationRouter v6
  '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch AggregationRouter v5 (legacy)
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x Exchange Proxy (mainnet)
  '0xdef171fe48cf0115b1d80b88dc8eab59176fee57', // ParaSwap Augustus V5 (legacy)
  '0x6a000f20005980200259b80c5102003040001068', // ParaSwap Augustus V6 (Velora)
  '0x216b4b4ba9f3e719726886d34a177484278bfcae', // ParaSwap Augustus V6.2
  '0x16c6521dff6bab339122a0fe25a9116693265353', // Curve CurveRouterNG (mainnet)
  ...(FEE_COLLECTOR_ADDRESS ? [FEE_COLLECTOR_ADDRESS] : []),
].map((a) => a.toLowerCase())

/** Always-trusted spenders for a chain: Permit2, CoW VaultRelayer, FeeCollector. */
function sharedSpenders(chainId: number): string[] {
  try {
    const cfg = getChainConfig(chainId)
    return [
      cfg.contracts.permit2,
      ...(cfg.contracts.cowVaultRelayer ? [cfg.contracts.cowVaultRelayer] : []),
      ...(cfg.contracts.feeCollector ? [cfg.contracts.feeCollector] : []),
      ...(cfg.contracts.feeCollectorV1 ? [cfg.contracts.feeCollectorV1] : []),
    ].map((a) => a.toLowerCase())
  } catch {
    return []
  }
}

/** The whitelisted router/spender addresses (lowercase) for a chain. */
export function getRouterWhitelist(chainId: number = DEFAULT_CHAIN_ID): string[] {
  // [ADR-010] Bebop's settlement + Balance Manager, whitelisted on 1 + 8453.
  const bebop = BEBOP_SPENDERS_BY_CHAIN[chainId] ?? []
  if (chainId === 1) return Array.from(new Set([...MAINNET_FULL, ...bebop]))
  const primaries = Object.values(ROUTER_WHITELIST_BY_CHAIN[chainId] ?? {}).map((a) => a.toLowerCase())
  return Array.from(new Set([...primaries, ...sharedSpenders(chainId), ...bebop]))
}

/** True when `address` is a whitelisted router/spender on `chainId`. */
export function isWhitelistedRouter(address: string, chainId: number = DEFAULT_CHAIN_ID): boolean {
  const lower = address.toLowerCase()
  return getRouterWhitelist(chainId).includes(lower)
}
