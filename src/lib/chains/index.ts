/**
 * [P216 / ADR-009] Multi-chain layer — barrel export.
 */
export type {
  ChainConfig,
  ChainContracts,
  ChainNativeCurrency,
  ChainRpc,
  GasModel,
} from './types'
export {
  CHAIN_CONFIGS,
  DEFAULT_CHAIN_ID,
  getChainConfig,
  getSupportedChainIds,
} from './registry'
export { getAdapterApiUrl } from './adapter-urls'
export { CHAINLINK_FEEDS_BY_CHAIN, getChainlinkFeed } from './chainlink-feeds'
export { isSequencerUp, SEQUENCER_GRACE_PERIOD_SEC } from './sequencer-check'
export { getRouterWhitelist, isWhitelistedRouter, ROUTER_WHITELIST_BY_CHAIN } from './routers'
export { getPopularTokens, getChainToken, getChainTokenList, remapTokenToChain, CHAIN_TOKENS, type ChainToken } from './tokens'
export { isChainActive, getChainStatus, getFeeIncompatibleSources, type ChainStatus } from './activation'
export { getPublicClientForChain } from './clients'
