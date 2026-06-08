import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import {
  rabbyWallet,
  metaMaskWallet,
  coinbaseWallet,
  walletConnectWallet,
  ledgerWallet,
  injectedWallet,
} from '@rainbow-me/rainbowkit/wallets'
import { mainnet, base } from 'wagmi/chains'
import { http, fallback } from 'wagmi'

// ── RPC Configuration with Fallback ──────────────────────
// Primary: user-configured RPC (e.g. Alchemy, Infura)
// Fallbacks: public RPCs for resilience when primary is down
const primaryRpc = process.env.NEXT_PUBLIC_RPC_URL
const fallbackRpc1 = process.env.NEXT_PUBLIC_FALLBACK_RPC_1
const fallbackRpc2 = process.env.NEXT_PUBLIC_FALLBACK_RPC_2

function buildMainnetTransport() {
  const transports = []

  // In browser: always use /api/rpc as primary (hides user IP, avoids CORS).
  if (typeof window !== 'undefined') {
    transports.push(http('/api/rpc', { timeout: 10_000 }))
  } else if (primaryRpc) {
    // Server-only: hit the configured RPC directly (no IP to protect).
    transports.push(http(primaryRpc, { timeout: 10_000 }))
  }

  // Fallback RPCs (secondary providers) — server-only; browser cannot
  // reach these directly without CORS allowlisting.
  if (typeof window === 'undefined') {
    if (fallbackRpc1) transports.push(http(fallbackRpc1, { timeout: 12_000 }))
    if (fallbackRpc2) transports.push(http(fallbackRpc2, { timeout: 12_000 }))
  }

  // Last resort: wagmi default public RPC (CORS-safe in browser)
  transports.push(http(undefined, { timeout: 15_000 }))

  // If only one transport, return it directly (no fallback wrapper needed)
  if (transports.length === 1) return transports[0]

  return fallback(transports, { rank: true, retryCount: 2 })
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
  chains: [mainnet, base],
  wallets: WALLET_GROUPS,
  transports: {
    [mainnet.id]: buildMainnetTransport(),
    [base.id]: fallback([
      http(process.env.NEXT_PUBLIC_BASE_RPC_URL || 'https://mainnet.base.org', { timeout: 10_000 }),
    ]),
  },
  ssr: true,
})
