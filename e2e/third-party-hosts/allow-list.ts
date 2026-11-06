/**
 * [fix/user-ip-privacy] Hosts the browser may contact, by situation. One source of truth: the wallet hosts are the
 * `connect-src` entries of the site's own CSP (csp-policy.js), where each carries its reason.
 */
import { WALLET_CONNECT_SOURCES } from '../../csp-policy'

/** NO WALLET: none. A visitor who has not chosen a wallet talks to our own origin only. */
export const NO_WALLET_ALLOWED_HOSTS: readonly string[] = []

/** A BROWSER-EXTENSION wallet (injected / EIP-6963): still none — the extension does its own networking, the page does not. */
export const INJECTED_WALLET_ALLOWED_HOSTS: readonly string[] = []

/** After a WalletConnect wallet is chosen: only that wallet's hosts from the CSP. */
export const WALLETCONNECT_ALLOWED_HOSTS: readonly string[] = (WALLET_CONNECT_SOURCES as ReadonlyArray<{ source: string; wallet: string }>)
  .filter((s) => s.wallet === 'WalletConnect')
  .map((s) => new URL(s.source).host)

/**
 * What the site's CSP is EXPECTED to refuse once WalletConnect is chosen — refusals that are the policy working, not a
 * regression. Anything else the CSP refuses fails the run.
 *  - `connect-src pulse.walletconnect.org`: Reown / WalletConnect telemetry. Refused on purpose (no SDK switch for it).
 *  - `frame-src verify.walletconnect.org`: WalletConnect's Verify API loads an <iframe>; frame-src is 'none' and was
 *    before this change (the wallet then shows the site as unverified — owner decision, see the feedback file).
 *  - `style-src-elem fonts.googleapis.com`: WalletConnect's own modal asks for a Google Fonts stylesheet; style-src
 *    has no remote host and had none before, so the modal renders in the fallback font.
 */
export const EXPECTED_CSP_REFUSALS_WITH_WALLETCONNECT: readonly string[] = [
  'connect-src pulse.walletconnect.org',
  'frame-src verify.walletconnect.org',
  'style-src-elem fonts.googleapis.com',
]
