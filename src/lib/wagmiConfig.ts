import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { mainnet } from 'wagmi/chains'
import { http, fallback } from 'wagmi'

// ── RPC Configuration with Fallback ──────────────────────
// Primary: user-configured RPC (e.g. Alchemy, Infura)
// Fallbacks: public RPCs for resilience when primary is down
const primaryRpc = process.env.NEXT_PUBLIC_RPC_URL
const fallbackRpc1 = process.env.NEXT_PUBLIC_FALLBACK_RPC_1
const fallbackRpc2 = process.env.NEXT_PUBLIC_FALLBACK_RPC_2

function buildMainnetTransport() {
  const transports = []

  // Primary RPC (configured by user — fastest, highest limits)
  if (primaryRpc) transports.push(http(primaryRpc, { timeout: 10_000 }))

  // Fallback RPCs (secondary providers)
  if (fallbackRpc1) transports.push(http(fallbackRpc1, { timeout: 12_000 }))
  if (fallbackRpc2) transports.push(http(fallbackRpc2, { timeout: 12_000 }))

  // Last resort: wagmi default public RPC
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

// [H-01] PRODUCTION: Only mainnet — Sepolia removed for mainnet deployment.
// For testnet development, add sepolia back temporarily:
//   import { sepolia } from 'wagmi/chains'
//   chains: [mainnet, sepolia]
export const config = getDefaultConfig({
  appName: 'TeraSwap',
  projectId: walletConnectProjectId,
  chains: [mainnet],
  transports: {
    [mainnet.id]: buildMainnetTransport(),
  },
  ssr: true,
})
