// @vitest-environment node
/**
 * [fix/user-ip-privacy] The WalletConnect "official modal" connector must not create its provider
 * (and with it Reown AppKit, whose creation calls api.web3modal.org and pulse.walletconnect.org)
 * until WalletConnect is actually chosen. The fakes below reproduce how wagmi drives a connector:
 * `setup()` at config creation and `getProvider().catch(...)` / `isAuthorized()` on reconnect.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { CreateConnectorFn } from 'wagmi'

const rk = vi.hoisted(() => ({ created: [] as Array<{ details: unknown; factory: unknown }> }))
vi.mock('@rainbow-me/rainbowkit/wallets', () => ({
  walletConnectWallet: (options: unknown) => ({
    id: 'walletConnect',
    name: 'WalletConnect',
    iconUrl: 'data:,',
    iconBackground: '#000',
    options,
    createConnector: (details: unknown) => {
      const factory = () => ({ id: 'walletConnect', tag: 'rainbowkit-factory-result' })
      rk.created.push({ details, factory })
      return factory
    },
  }),
}))

import { lazyConnector, lazyWalletConnectWallet, WALLETCONNECT_CONNECTOR_ID } from './lazy-walletconnect'

type Spy = Mock<(...args: unknown[]) => Promise<unknown>>
interface FakeInner {
  getProvider: Spy
  isAuthorized: Spy
  connect: Spy
  setupReachedProvider: Spy
}

/** A connector shaped like wagmi's walletConnect one: every method goes through `this`. */
function fakeWalletConnect(): { create: CreateConnectorFn; inner: FakeInner } {
  const inner: FakeInner = {
    getProvider: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ provider: 'real' })),
    isAuthorized: vi.fn(async (..._args: unknown[]): Promise<unknown> => true),
    connect: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ accounts: ['0x1'], chainId: 1 })),
    setupReachedProvider: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  }
  const create = (() => ({
    id: 'walletConnect',
    name: 'WalletConnect',
    type: 'walletConnect',
    rkDetails: { id: 'walletConnect', isWalletConnectModalConnector: true, showQrModal: true },
    // wagmi's own shape: `const provider = await this.getProvider().catch(() => null); if (!provider) return`
    async setup(this: { getProvider: () => Promise<unknown> }) {
      const provider = await this.getProvider().catch(() => null)
      if (!provider) return
      inner.setupReachedProvider()
    },
    getProvider(this: unknown, ...args: unknown[]) {
      return inner.getProvider.call(this, ...args)
    },
    isAuthorized(this: unknown) {
      return inner.isAuthorized.call(this)
    },
    connect(this: unknown, ...args: unknown[]) {
      return inner.connect.call(this, ...args)
    },
  })) as unknown as CreateConnectorFn
  return { create, inner }
}

/** What wagmi's createConfig does with a connector factory. */
function wagmiSetup(create: CreateConnectorFn, recentConnectorId: unknown = null, getItem?: () => Promise<unknown>) {
  const storage = { getItem: vi.fn(getItem ?? (async (key: string) => (key === 'recentConnectorId' ? recentConnectorId : null))) }
  const connector = { ...create({ storage, chains: [], emitter: {}, transports: {} } as never), emitter: {}, uid: 'uid-1' } as unknown as {
    setup: () => Promise<void>
    getProvider: (p?: unknown) => Promise<unknown>
    isAuthorized: () => Promise<boolean>
    connect: (p?: unknown) => Promise<unknown>
    rkDetails: unknown
    uid: string
  }
  return { connector, storage }
}

beforeEach(() => {
  rk.created.length = 0
})

describe('lazyConnector — a first-time visitor (no recent connector)', () => {
  it('setup() does not reach the provider', async () => {
    const { create, inner } = fakeWalletConnect()
    const { connector } = wagmiSetup(lazyConnector(create))
    await connector.setup()
    expect(inner.getProvider).not.toHaveBeenCalled()
    expect(inner.setupReachedProvider).not.toHaveBeenCalled()
  })

  it('wagmi reconnect skips it: getProvider() rejects, isAuthorized() is false, the real connector is never asked', async () => {
    const { create, inner } = fakeWalletConnect()
    const { connector } = wagmiSetup(lazyConnector(create))
    await expect(connector.getProvider()).rejects.toThrow(/not initialised until it is chosen/)
    await expect(connector.getProvider().catch(() => undefined)).resolves.toBeUndefined() // wagmi's own reconnect line
    await expect(connector.isAuthorized()).resolves.toBe(false)
    expect(inner.getProvider).not.toHaveBeenCalled()
    expect(inner.isAuthorized).not.toHaveBeenCalled()
  })

  it.each([['io.metamask'], ['injected'], ['coinbaseWalletSDK'], [null], [undefined], ['']])(
    'stays un-armed when the last connector was %j',
    async (recent) => {
      const { create, inner } = fakeWalletConnect()
      const { connector } = wagmiSetup(lazyConnector(create), recent)
      await connector.setup()
      await connector.getProvider().catch(() => undefined)
      expect(inner.getProvider).not.toHaveBeenCalled()
    },
  )

  it('stays un-armed when storage cannot be read', async () => {
    const { create, inner } = fakeWalletConnect()
    const { connector } = wagmiSetup(lazyConnector(create), null, async () => {
      throw new Error('storage blocked')
    })
    await connector.setup()
    await expect(connector.isAuthorized()).resolves.toBe(false)
    expect(inner.getProvider).not.toHaveBeenCalled()
  })

  it('keeps RainbowKit’s connector details (the modal flag RainbowKit looks for)', () => {
    const { create } = fakeWalletConnect()
    const { connector } = wagmiSetup(lazyConnector(create))
    expect(connector.rkDetails).toEqual({ id: 'walletConnect', isWalletConnectModalConnector: true, showQrModal: true })
  })
})

describe('lazyConnector — armed by choosing WalletConnect', () => {
  it('connect() goes to the real connector with wagmi’s `this`, and the provider is reachable afterwards', async () => {
    const { create, inner } = fakeWalletConnect()
    const { connector } = wagmiSetup(lazyConnector(create))
    await expect(connector.connect({ chainId: 8453 })).resolves.toEqual({ accounts: ['0x1'], chainId: 1 })
    expect(inner.connect).toHaveBeenCalledTimes(1)
    expect(inner.connect.mock.calls[0]).toEqual([{ chainId: 8453 }])
    expect((inner.connect.mock.contexts[0] as { uid: string }).uid).toBe('uid-1') // the outer (wagmi) object, not the inner one

    await expect(connector.getProvider({ chainId: 1 })).resolves.toEqual({ provider: 'real' })
    expect(inner.getProvider).toHaveBeenCalledWith({ chainId: 1 })
    expect((inner.getProvider.mock.contexts[0] as { uid: string }).uid).toBe('uid-1')
    await expect(connector.isAuthorized()).resolves.toBe(true)
  })

  it('a connect() that fails still leaves the connector usable for a retry', async () => {
    const { create, inner } = fakeWalletConnect()
    inner.connect.mockRejectedValueOnce(new Error('user rejected'))
    const { connector } = wagmiSetup(lazyConnector(create))
    await expect(connector.connect()).rejects.toThrow('user rejected')
    await expect(connector.connect()).resolves.toBeDefined()
    expect(inner.connect).toHaveBeenCalledTimes(2)
  })
})

describe('lazyConnector — a returning WalletConnect user', () => {
  it(`is armed by wagmi's recentConnectorId === "${WALLETCONNECT_CONNECTOR_ID}": setup and reconnect behave as before`, async () => {
    const { create, inner } = fakeWalletConnect()
    const { connector, storage } = wagmiSetup(lazyConnector(create), WALLETCONNECT_CONNECTOR_ID)
    await connector.setup()
    expect(storage.getItem).toHaveBeenCalledWith('recentConnectorId')
    expect(inner.getProvider).toHaveBeenCalledTimes(1)
    expect(inner.setupReachedProvider).toHaveBeenCalledTimes(1)
    await expect(connector.isAuthorized()).resolves.toBe(true)
    expect(inner.isAuthorized).toHaveBeenCalledTimes(1)
  })
})

describe('lazyWalletConnectWallet — RainbowKit’s wallet, only the modal connector is lazy', () => {
  it('is the same wallet (id, name) built from the same options', () => {
    const wallet = lazyWalletConnectWallet({ projectId: 'p' } as never) as unknown as { id: string; name: string; options: unknown }
    expect(wallet.id).toBe('walletConnect')
    expect(wallet.name).toBe('WalletConnect')
    expect(wallet.options).toEqual({ projectId: 'p' })
  })

  it('returns the QR connector factory untouched', () => {
    const wallet = lazyWalletConnectWallet({ projectId: 'p' } as never)
    const details = { rkDetails: { id: 'walletConnect' } } as never
    const factory = wallet.createConnector(details)
    expect(rk.created).toHaveLength(1)
    expect(factory).toBe(rk.created[0].factory)
    expect(rk.created[0].details).toBe(details)
  })

  it('wraps the `showQrModal: true` connector (isWalletConnectModalConnector)', () => {
    const wallet = lazyWalletConnectWallet({ projectId: 'p' } as never)
    const factory = wallet.createConnector({ rkDetails: { id: 'walletConnect', isWalletConnectModalConnector: true, showQrModal: true } } as never)
    expect(rk.created).toHaveLength(1)
    expect(factory).not.toBe(rk.created[0].factory)
    // the wrapper still produces RainbowKit's connector underneath
    expect((factory({ storage: null } as never) as unknown as { tag: string }).tag).toBe('rainbowkit-factory-result')
  })
})
