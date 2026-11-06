/**
 * [fix/user-ip-privacy] WalletConnect's "official modal" connector, without the page-load phone-home.
 *
 * WHAT WAS HAPPENING. RainbowKit registers `walletConnectWallet` twice: the QR connector, and a second
 * one built with `showQrModal: true` so the user can open WalletConnect's own modal instead. wagmi calls
 * `setup()` on every connector when the config is created and `getProvider()` on every connector when it
 * reconnects on mount. For that second connector `getProvider()` runs `EthereumProvider.init({ showQrModal:
 * true })`, which creates a Reown AppKit instance — and AppKit, on creation, fetches
 * `api.web3modal.org/appkit/v1/config` and posts an `INITIALIZE` event to `pulse.walletconnect.org/e`.
 * So EVERY visitor's browser, with no wallet and before any click, told Reown its IP, user agent and
 * the page it was on (recon/user-ip-privacy, measured on v1 and v2, all three chains).
 *
 * WHY NOT A CONFIG FLAG. AppKit only sends events when `features.analytics` is on, but the options object
 * is built inside `@walletconnect/ethereum-provider` (`convertWCMToAppKitOptions`) from a fixed set of
 * fields — `features` is hard-coded to `{ email: false, socials: false }` and nothing we pass through
 * `qrModalOptions` reaches it. The SDK does not allow it, so the telemetry host is refused by the CSP
 * instead (next.config.js) and the connector is made lazy here so there is nothing to refuse on load.
 * (WalletConnect CORE telemetry is a separate switch, `telemetryEnabled`, and it is off — wagmiConfig.ts.)
 *
 * WHAT THIS DOES. It wraps ONLY the modal connector. Until it is "armed" its `getProvider()` rejects,
 * which is exactly what wagmi's `setup()` and `reconnect()` already tolerate (`.catch(() => …)`): they
 * skip the connector, the provider is never initialised, AppKit is never created, nothing is fetched.
 * It is armed by:
 *   - `getChainId()` / `connect()` — the user chose "open the official WalletConnect modal". RainbowKit
 *     calls them in that order (`connectWallet`: `await connector.getChainId()`, then `connectAsync`), and
 *     neither wagmi nor RainbowKit calls either on a connector that is not connected or being connected;
 *     or
 *   - a returning visitor whose last connector was WalletConnect (wagmi's own `recentConnectorId`), so
 *     their session is restored on reload exactly as before.
 * Both are "a WalletConnect wallet was chosen", which is the point at which the site says the wallet's
 * own network traffic begins.
 *
 * WHAT IT DOES NOT TOUCH. The QR connector (RainbowKit's own modal) and every other wallet are returned
 * as they are. EIP-6963 / injected discovery never goes through WalletConnect, so extension wallets are
 * unaffected. Once armed, every call is passed straight to the real connector with wagmi's own `this`.
 */
import { walletConnectWallet } from '@rainbow-me/rainbowkit/wallets'
import type { Wallet, WalletDetailsParams } from '@rainbow-me/rainbowkit'
import type { CreateConnectorFn } from 'wagmi'

/** wagmi's WalletConnect connector id — also the value wagmi stores as `recentConnectorId`. */
export const WALLETCONNECT_CONNECTOR_ID = 'walletConnect'

type ConnectorInstance = ReturnType<CreateConnectorFn>

/** Wrap a connector factory so its provider is not created before the connector is armed. */
export function lazyConnector(create: CreateConnectorFn): CreateConnectorFn {
  return ((config: Parameters<CreateConnectorFn>[0]) => {
    const inner = create(config)
    let armed = false

    /** Armed by a connect(), or because WalletConnect was this visitor's last connector. */
    const isArmed = async (): Promise<boolean> => {
      if (armed) return true
      try {
        const recent = await config.storage?.getItem('recentConnectorId')
        if (recent === inner.id) armed = true
      } catch {
        // unreadable storage: stay un-armed (no session can be restored without it anyway)
      }
      return armed
    }

    const lazy: ConnectorInstance = {
      ...inner,
      async getProvider(parameters) {
        if (!(await isArmed())) throw new Error('WalletConnect modal connector is not initialised until it is chosen')
        return inner.getProvider.call(this, parameters)
      },
      async isAuthorized() {
        if (!(await isArmed())) return false
        return inner.isAuthorized.call(this)
      },
      // The two calls a user's choice starts with (see the header). They arm the connector; `getProvider`
      // and `isAuthorized` above are what wagmi probes on page load, and they never do.
      async getChainId() {
        armed = true
        return inner.getChainId.call(this)
      },
      async connect(parameters) {
        armed = true
        return inner.connect.call(this, parameters)
      },
    } as ConnectorInstance

    return lazy
  }) as CreateConnectorFn
}

/**
 * Drop-in for RainbowKit's `walletConnectWallet`: same wallet, same two connectors, but the
 * `showQrModal: true` one (`rkDetails.isWalletConnectModalConnector`) is lazy.
 */
export const lazyWalletConnectWallet: typeof walletConnectWallet = (options) => {
  const wallet: Wallet = walletConnectWallet(options)
  return {
    ...wallet,
    createConnector: (walletDetails: WalletDetailsParams): CreateConnectorFn => {
      const create = wallet.createConnector(walletDetails)
      return walletDetails.rkDetails.isWalletConnectModalConnector ? lazyConnector(create) : create
    },
  }
}
