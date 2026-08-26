import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import {
  rabbyWallet,
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  ledgerWallet,
  injectedWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { mainnet, base, arbitrum } from 'wagmi/chains'
import { fallback } from 'wagmi'
import type { Transport } from 'viem'
import { guardedHttp } from '@/lib/rpc-guarded-transport'

// ── RPC Configuration with Fallback ──────────────────────
// Primary: user-configured RPC (e.g. Alchemy, Infura)
// Fallbacks: public RPCs for resilience when primary is down
//
// [FIX-RPC-CHAIN-IDENTITY-GUARD] Every transport below is built with `guardedHttp`, never bare
// `http`. NEXT_PUBLIC_ARBITRUM_RPC_URL held a BASE endpoint from 2026-08-05 to 2026-08-26: viem
// forwarded Base's answers as Arbitrum's for three weeks without a single error, because a
// well-formed 200 from the wrong chain is not an error to any layer below this one. guardedHttp
// asks each endpoint `eth_chainId` once (cached per process — see rpc-chain-identity.ts) and
// refuses to read from one that answers for a different chain. An UNREACHABLE endpoint is an
// outage, not a lie, and still falls through to the next entry exactly as it does today.
const primaryRpc = process.env.NEXT_PUBLIC_RPC_URL
const fallbackRpc1 = process.env.NEXT_PUBLIC_FALLBACK_RPC_1
const fallbackRpc2 = process.env.NEXT_PUBLIC_FALLBACK_RPC_2

function buildMainnetTransport(): Transport {
  const transports: Transport[] = []

  // In browser: always use /api/rpc as primary (hides user IP, avoids CORS).
  if (typeof window !== 'undefined') {
    transports.push(guardedHttp('/api/rpc', mainnet.id, { timeout: 10_000 }))
  } else if (primaryRpc) {
    // Server-only: hit the configured RPC directly (no IP to protect).
    transports.push(guardedHttp(primaryRpc, mainnet.id, { timeout: 10_000 }))
  }

  // Fallback RPCs (secondary providers) — server-only; browser cannot
  // reach these directly without CORS allowlisting.
  if (typeof window === 'undefined') {
    if (fallbackRpc1) transports.push(guardedHttp(fallbackRpc1, mainnet.id, { timeout: 12_000 }))
    if (fallbackRpc2) transports.push(guardedHttp(fallbackRpc2, mainnet.id, { timeout: 12_000 }))
  }

  // No implicit/URL-less http() entry here: an unconfigured `http(undefined)`
  // resolves to viem's built-in chain default (eth.merkle.io for mainnet),
  // an endpoint we never chose and that isn't CORS-allowlisted for the
  // browser. Every RPC URL used must be explicit — see Base/Arbitrum below.
  //
  // Server-only last resort, only reached if no primary/fallback env vars are
  // set: an EXPLICIT written-down URL (same constant used by src/lib/rpc.ts
  // and src/lib/on-chain-monitor.ts), not viem's implicit chain default.
  if (typeof window === 'undefined' && transports.length === 0) {
    transports.push(guardedHttp('https://eth.llamarpc.com', mainnet.id, { timeout: 15_000 }))
  }

  // If only one transport, return it directly (no fallback wrapper needed)
  if (transports.length === 1) return transports[0]

  // No `rank`: /api/rpc (our privacy-preserving proxy) must stay authoritative
  // and never be demoted below a fallback by a latency/stability heuristic —
  // rank:true also runs an unbounded background pinger against every
  // transport in the array for the client's lifetime.
  return fallback(transports, { retryCount: 2 })
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
  appDescription: 'Ethereum & Base meta-aggregator — best swap price across 11 liquidity sources, with MEV protection.',
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
export const WALLET_GROUPS = [
  {
    groupName: 'Recommended',
    wallets: [rabbyWallet, metaMaskWallet, coinbaseWallet, walletConnectWallet],
  },
  {
    groupName: 'More',
    wallets: [ledgerWallet, injectedWallet],
  },
]

// [P219] Multi-chain: mainnet stays the default (first in the array, so wallets
// connect to it by default). Base is added so users can switch, but swaps stay
// gated behind "Coming Soon" until a Base FeeCollector is deployed (ChainSelector).
// Base uses the public RPC for now (NEXT_PUBLIC_BASE_RPC_URL overrides).
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
  transports: {
    [mainnet.id]: buildMainnetTransport(),
    [base.id]: fallback([
      guardedHttp(process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org', base.id, { timeout: 10_000 }),
    ]),
    [arbitrum.id]: fallback([
      guardedHttp(process.env.NEXT_PUBLIC_ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc', arbitrum.id, { timeout: 10_000 }),
      guardedHttp('https://arb1.arbitrum.io/rpc', arbitrum.id),
    ]),
  },
  ssr: true,
})
