import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import {
  rabbyWallet,
  metaMaskWallet,
  coinbaseWallet,
  ledgerWallet,
  injectedWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { lazyWalletConnectWallet } from '@/lib/lazy-walletconnect'
import { mainnet, base, arbitrum } from 'wagmi/chains'
import type { Transport } from 'viem'
import { guardedHttp } from '@/lib/rpc-guarded-transport'
import { INTEGRATED_DEX_SOURCE_COUNT, SWAP_CHAIN_LIST_LABEL } from '@/config/product-claims'
import { proxyRpcUrl } from '@/lib/rpc-proxy-url'
import { serverRpcUrl } from '@/lib/rpc-env'

// ── RPC transports ───────────────────────────────────────
// [FIX-RPC-CHAIN-IDENTITY-GUARD] Every transport below is built with `guardedHttp`, never bare
// `http`. NEXT_PUBLIC_ARBITRUM_RPC_URL held a BASE endpoint from 2026-08-05 to 2026-08-26: viem
// forwarded Base's answers as Arbitrum's for three weeks without a single error, because a
// well-formed 200 from the wrong chain is not an error to any layer below this one. guardedHttp
// asks each endpoint `eth_chainId` once (cached per process — see rpc-chain-identity.ts) and
// refuses to read from one that answers for a different chain. An UNREACHABLE endpoint is an
// outage, not a lie.
//
// No implicit/URL-less http() entry: an unconfigured `http(undefined)` resolves to viem's built-in
// chain default (eth.merkle.io for mainnet), an endpoint we never chose. Every URL is explicit.

/**
 * [fix/user-ip-privacy] One transport per chain, the same builder for Ethereum, Base and Arbitrum.
 *
 * Browser: our own proxy and nothing else — `/api/rpc` for mainnet, `/api/rpc?chainId=<id>` otherwise
 * (rpc-proxy-url.ts). Absolute same-origin URL: wagmi's WalletConnect connector copies this transport URL
 * into the provider's rpcMap, and WalletConnect refuses a relative one ("Provided URL is not compatible
 * with HTTP connection: /api/rpc") while it builds the session's EVM provider. There is no direct fallback
 * in the browser: a second entry here would be a third-party host again.
 *
 * Server (this module is evaluated once without `window` because of `ssr: true`): the server resolver,
 * `serverRpcUrl` — RPC_URL_<id> first, then (mainnet only) RPC_URL, then the public default.
 *
 * [fix/mainnet-rpc-out-of-client, SEC-5] Mainnet used to have its own builder. Its browser branch was this one,
 * but its server branch read three NEXT_PUBLIC_* names (the mainnet RPC and two fallbacks) with literal member
 * accesses, and a literal NEXT_PUBLIC_* read in a module the browser reaches is inlined into its client chunk.
 * No NEXT_PUBLIC_* RPC name is read in this file any more.
 */
function buildTransport(chainId: number): Transport {
  if (typeof window !== 'undefined') {
    return guardedHttp(proxyRpcUrl(chainId), chainId, { timeout: 10_000 })
  }
  return guardedHttp(serverRpcUrl(chainId), chainId, { timeout: 10_000 })
}

// [BUGFIX] Validate WalletConnect projectId — empty string causes silent failures
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? ''
if (!walletConnectProjectId && typeof window !== 'undefined') {
  console.warn(
    '[TeraSwap] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. ' +
    'WalletConnect will not work. Get one at https://cloud.walletconnect.com'
  )
}

// [SPRINT-9K] Explicit WalletConnect dApp metadata.
// Set the url/icon EXPLICITLY rather than letting WalletConnect auto-derive them
// from window.location: with `ssr: true` this module is evaluated server-side
// (no `window`) at import time, so an auto-derived url can be empty/incorrect,
// which the Verify API rejects. A fixed url on a Reown-VERIFIED domain
// (www.teraswap.app) keeps the session proposal valid.
// NOTE: [SPRINT-9M] www is now the single canonical host — SITE_URL in app/layout.tsx
// is https://www.teraswap.app and apex→www is redirect-enforced (next.config.js), so
// origin ⇔ canonical ⇔ WC metadata all align to www. Both apex + www remain allowlisted
// in Reown. See FEEDBACK.
export const WALLETCONNECT_METADATA = {
  appName: 'TeraSwap',
  // [fix/privacy-leftovers-a78b] Wallets show this when you connect. Same words and the same two constants as the page description
  // (SITE_META_DESCRIPTION in product-claims.ts): the chain list is the chain registry's, the count is the quoting adapters', and no
  // "best" (the claims file makes no such promise). Pinned by metadata.copy.guard.test.ts and wagmiConfig.test.ts.
  appDescription: `TeraSwap is an EVM meta-aggregator on ${SWAP_CHAIN_LIST_LABEL} that compares quotes across ${INTEGRATED_DEX_SOURCE_COUNT} liquidity sources.`,
  appUrl: 'https://www.teraswap.app',
  appIcon: 'https://www.teraswap.app/apple-touch-icon.png',
} as const

// [SPRINT-9Z] Explicit, mobile-friendly wallet list.
// getDefaultConfig's DEFAULT list curates a subset that HIDES several wallets on
// mobile — real users couldn't find Rabby / Ledger / D'CENT in the picker. Passing
// an explicit `wallets` list fixes that. The generic `walletConnectWallet` is the
// catch-all that covers D'CENT and ANY WalletConnect wallet via QR / deep-link.
// The list has no platform branch, so mobile and desktop render the identical set.
// getDefaultConfig still builds a SINGLE provider/Core from this list (9K holds).
// [fix/user-ip-privacy] `lazyWalletConnectWallet` IS RainbowKit's walletConnectWallet (same id, same two
// connectors); only its "official modal" connector waits to be chosen before it creates its provider,
// because creating it made every visitor's browser call api.web3modal.org and pulse.walletconnect.org
// on page load. See lazy-walletconnect.ts.
export const WALLET_GROUPS = [
  {
    groupName: 'Recommended',
    wallets: [rabbyWallet, metaMaskWallet, coinbaseWallet, lazyWalletConnectWallet],
  },
  {
    groupName: 'More',
    wallets: [ledgerWallet, injectedWallet],
  },
]

// [P219] Multi-chain: mainnet stays the default (first in the array, so wallets
// connect to it by default). Base is added so users can switch, but swaps stay
// gated behind "Coming Soon" until a Base FeeCollector is deployed (ChainSelector).
// [fix/user-ip-privacy] Base and Arbitrum read through /api/rpc?chainId=<id>, mainnet through /api/rpc
// ([SEC-5] all three from the same builder, buildTransport).
//
// `config` is a MODULE SINGLETON — created exactly once per runtime so there is a
// single WalletConnect Core/provider instance. Do NOT recreate it per-render
// (a second Core subscribes to a different pairing topic → the wallet settles a
// topic the dApp isn't listening on → session_settle never reflects). See 9K.
export const config = getDefaultConfig({
  ...WALLETCONNECT_METADATA,
  projectId: walletConnectProjectId,
  chains: [mainnet, base, arbitrum],
  wallets: WALLET_GROUPS,
  // [fix/user-ip-privacy] WalletConnect CORE telemetry (error events to pulse.walletconnect.org/batch) off.
  // This is already RainbowKit's default; it is stated here so a default change upstream cannot turn it on.
  walletConnectParameters: { telemetryEnabled: false },
  transports: {
    [mainnet.id]: buildTransport(mainnet.id),
    [base.id]: buildTransport(base.id),
    [arbitrum.id]: buildTransport(arbitrum.id),
  },
  // [feat/frontend-rpc-diet] viem splits a Multicall3 into calldata chunks of `batchSize` bytes — default 1 024, i.e.
  // ~5 balanceOf reads per eth_call — so refreshing a 30-token balance list cost ~6 provider calls instead of 1.
  // 16 KiB keeps one refresh of the largest catalog (Arbitrum, 227 tokens) at ~3 calls, far below every provider's
  // request-size and eth_call-gas limits. `wait` stays 0: no added latency, same-tick reads still share a request.
  batch: { multicall: { batchSize: 16_384 } },
  ssr: true,
})
