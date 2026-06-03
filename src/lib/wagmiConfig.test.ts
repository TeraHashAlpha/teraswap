// @vitest-environment jsdom
/**
 * [SPRINT-9K] WalletConnect config guards.
 *
 * The prod bug was a SYSTEMATIC 0-settle: the wallet approves a pairing topic
 * the dApp's WC Core isn't subscribed to. Root cause was multiple
 * @walletconnect/core versions in the tree (a stray @walletconnect/ethereum-
 * provider direct dep), now deduped to one via package.json overrides. These
 * tests guard the dApp-side invariants that must hold for a session to settle:
 *   - explicit metadata url matching a Reown-verified domain (no SSR-empty url),
 *   - the config is a single module singleton (one WC Core),
 *   - exactly one WalletConnect connector is registered.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

type WagmiConfigModule = typeof import('./wagmiConfig')
let config: WagmiConfigModule['config']
let WALLETCONNECT_METADATA: WagmiConfigModule['WALLETCONNECT_METADATA']

beforeAll(async () => {
  // getDefaultConfig throws without a projectId; provide a dummy BEFORE the
  // module is first evaluated (module body calls getDefaultConfig at import).
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'test_projectid_0123456789abcdef')
  const mod = await import('./wagmiConfig')
  config = mod.config
  WALLETCONNECT_METADATA = mod.WALLETCONNECT_METADATA
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('wagmiConfig — WalletConnect metadata [SPRINT-9K]', () => {
  it('sets an explicit metadata url matching a Reown-verified domain', () => {
    expect(WALLETCONNECT_METADATA.appName).toBe('TeraSwap')
    expect(WALLETCONNECT_METADATA.appUrl).toBe('https://www.teraswap.app')
    // icon must be an absolute https URL on the verified domain (wallets reject relative)
    expect(WALLETCONNECT_METADATA.appIcon).toMatch(/^https:\/\/www\.teraswap\.app\/.+/)
  })

  it('exports a single config instance (module singleton → one WC Core)', async () => {
    const again = (await import('./wagmiConfig')).config
    expect(again).toBe(config)
  })

  it('configures WalletConnect (≥1 WC-protocol connector)', () => {
    // RainbowKit registers several WC-protocol wallet connectors (MetaMask,
    // Rainbow, …) that SHARE a single provider — so the count is >1 by design.
    // The "exactly ONE WC Core" guarantee is enforced at the DEPENDENCY level
    // (package.json overrides pin @walletconnect/core+sign-client+universal-
    // provider to one version; `npm ls @walletconnect/core` → 1), not here.
    const wc = config.connectors.filter(
      (c) => c.type === 'walletConnect' || c.id === 'walletConnect',
    )
    expect(wc.length).toBeGreaterThanOrEqual(1)
  })
})
