/**
 * [fix/user-ip-privacy] The site's Content-Security-Policy, as data.
 *
 * WHY IT IS ITS OWN FILE. The policy is the lock on "this site never sends the visitor's IP to a third
 * party": the browser can only open a connection to a host listed here. It used to be one long string
 * in next.config.js that had grown to 30 sources (aggregator APIs, RPC providers, Supabase, Sentry,
 * wildcard WalletConnect domains) — far wider than what the browser needed, and nobody could say why a
 * given host was there. Here every source carries its reason, next.config.js builds the header from
 * this list, the tests read the same list (src/lib/security-headers.test.ts), and so does the headless
 * capture that runs in CI (e2e/third-party-hosts).
 *
 * THE RULE. `connect-src` is 'self' plus the wallet hosts below and nothing else. Every read the site
 * makes — RPC on all three chains, quotes, swaps, prices, token logos, order status — goes to our own
 * origin. A wallet host is contacted only AFTER the visitor chooses that wallet (or returns with a
 * session of it); with no wallet chosen the browser talks to our origin only.
 *
 * NOT LISTED, ON PURPOSE (each was allowed before; none is needed by the browser):
 *  - RPC providers (Alchemy, Infura, llamarpc, Ankr, publicnode, merkle): all reads go through /api/rpc.
 *  - Aggregator / DEX APIs (1inch, 0x, ParaSwap, KyberSwap, CoW, OpenOcean, Sushi, Balancer) and
 *    Etherscan: called by our API routes, never by the page.
 *  - Supabase: order status is polled through /api/orders; the browser-side realtime socket is gone.
 *  - Sentry ingest: the SDK is not initialised in the browser (see docs/security/SENTRY-STATUS.md).
 *  - pulse.walletconnect.org: Reown / WalletConnect TELEMETRY. Refused here because the SDK offers no
 *    switch for it on our path (src/lib/lazy-walletconnect.ts). AppKit swallows the failed request.
 *  - rpc.walletconnect.org: WalletConnect's own RPC. The provider is given our proxy for every chain
 *    (wagmi rpcMap, pinned in wagmiConfig.browser-transports.test.ts), so it never needs it.
 *  - verify / echo / explorer-api.walletconnect.*, api.web3modal.com: not referenced by the installed
 *    SDKs for a dApp-side connection. (The Verify API is an <iframe>, governed by frame-src 'none'.)
 *  - Coinbase: Smart Wallet connects through a popup window, which connect-src does not govern
 *    (Cross-Origin-Opener-Policy: same-origin-allow-popups keeps it working — security-headers test).
 *
 * `img-src` is 'self' data: blob: — every token logo is served by /api/token-logo or /api/proxy/logo;
 * `data:` covers inline wallet icons (EIP-6963, RainbowKit) and `blob:` the wallet logos WalletConnect's
 * modal fetches through connect-src and renders as object URLs.
 */

/**
 * Wallet hosts the browser may connect to, and why. Exact hosts — no wildcard.
 * @type {ReadonlyArray<{ source: string, wallet: string, reason: string }>}
 */
const WALLET_CONNECT_SOURCES = Object.freeze([
  {
    source: 'wss://relay.walletconnect.org',
    wallet: 'WalletConnect',
    reason:
      'The WalletConnect relay: the end-to-end encrypted channel between this page and a WalletConnect wallet (QR code, mobile deep link, Ledger Live). Opened when a WalletConnect-based wallet is chosen, and again when such a session is restored.',
  },
  {
    source: 'https://api.web3modal.org',
    wallet: 'WalletConnect',
    reason:
      "Reown's wallet directory for WalletConnect's own modal: its configuration, the wallet list and the wallet logos. Contacted only once the visitor opens that modal (the connector is lazy), or returns with a WalletConnect session.",
  },
  {
    source: 'https://metamask-sdk.api.cx.metamask.io',
    wallet: 'MetaMask',
    reason:
      'The MetaMask SDK relay (HTTPS handshake of its socket): used when MetaMask is chosen in a browser that has no MetaMask extension, to pair with the MetaMask mobile app.',
  },
  {
    source: 'wss://metamask-sdk.api.cx.metamask.io',
    wallet: 'MetaMask',
    reason: 'The same MetaMask SDK relay, over WebSocket, once the handshake has upgraded.',
  },
])

/** `connect-src` sources, in order. */
const CONNECT_SRC = Object.freeze(["'self'", ...WALLET_CONNECT_SOURCES.map((s) => s.source)])

/** `img-src` sources: our origin, inline images, object URLs. No remote image host. */
const IMG_SRC = Object.freeze(["'self'", 'data:', 'blob:'])

/**
 * The full policy string. `isDev` adds 'unsafe-eval' to script-src (Next.js dev tooling needs it).
 * @param {{ isDev?: boolean }} [options]
 */
function buildContentSecurityPolicy({ isDev = false } = {}) {
  return [
    "default-src 'self'",
    // Scripts: self + inline (Next.js requires it); unsafe-eval only in dev
    // worker-src 'self' required for service worker registration
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    "worker-src 'self'",
    // Styles: self + inline (Tailwind/Next.js)
    "style-src 'self' 'unsafe-inline'",
    `img-src ${IMG_SRC.join(' ')}`,
    // Fonts: all self-hosted via next/font/local (Inter, JetBrains Mono, Clash Display)
    "font-src 'self' data:",
    `connect-src ${CONNECT_SRC.join(' ')}`,
    // Media: self (local sound files in /public/sounds/)
    "media-src 'self' blob:",
    // Frames: none (clickjacking protection)
    "frame-src 'none'",
    "frame-ancestors 'none'",
    // Objects: none
    "object-src 'none'",
    // Base URI
    "base-uri 'self'",
    // Form actions
    "form-action 'self'",
  ].join('; ')
}

module.exports = { WALLET_CONNECT_SOURCES, CONNECT_SRC, IMG_SRC, buildContentSecurityPolicy }
