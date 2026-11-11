/**
 * [fix/user-ip-privacy] Recording rig for the third-party-host capture.
 *
 * Records every request the PAGE makes to an origin that is not the app's own — HTTP(S) through `context.route`,
 * WebSockets through `routeWebSocket` — and answers each locally, so nothing leaves the machine. It also records what the
 * site's own Content-Security-Policy refused (a `securitypolicyviolation` is an attempt the browser never sent).
 *
 * Same-origin traffic: `/api/rpc` goes to the REAL route handler (its upstream is the local stub, rpc-stub.mjs), so the
 * proxy's allow-list is exercised by the app's own calls; every other `/api/*` is answered here with an empty body so the
 * Next server never dials an aggregator or a logo CDN during the run. Everything else on our origin loads normally.
 */
import type { BrowserContext, Page } from '@playwright/test'

export interface HostRecord {
  host: string
  kind: 'http' | 'ws'
  count: number
  methods: string[]
  paths: string[]
  phases: string[]
}

export interface CaptureResult {
  /** Requests that would have left for another origin (recorded, then answered locally). */
  thirdParty: HostRecord[]
  /** Attempts the site's CSP refused: `<directive> <blocked host>` → count. */
  cspBlocked: Record<string, number>
  /** Same-origin `/api/*` calls by path (`/api/rpc` keeps its query: the chain it reads). */
  sameOriginApi: Record<string, number>
  /** JSON-RPC methods the app sent to `/api/rpc`, per proxied chain. */
  rpcMethods: Record<string, Record<string, number>>
  /** `/api/rpc` answers that were not 200 — a 403 is a method the allow-list refused. */
  rpcRefusals: string[]
}

/** Strip anything that identifies a key or a wallet from a path before it is written to a report. */
const scrub = (pathname: string) =>
  pathname
    .replace(/0x[0-9a-fA-F]{40}/g, '0x…')
    .replace(/\/v2\/[^/]+/, '/v2/<key>')
    .slice(0, 70)

/** A scenario's own answer for a same-origin `/api/*` call (see `Capture.apiOverride`); null = default handling. */
export type ApiOverride = (url: URL, request: { method: string; json: () => unknown }) => { status: number; json: unknown } | null

export class Capture {
  /**
   * [A76 S-1] Lets a scenario answer chosen same-origin API calls itself — the CoW scenario answers /api/rpc with an
   * ABI-aware stub (balances, allowances, Chainlink) and /api/quote, /api/swap, /api/cow/* with a CoW order's
   * lifecycle — so the app can be driven to a signed CoW order without anything leaving the machine.
   */
  apiOverride: ApiOverride | null = null
  /** Bodies the page POSTed to same-origin `/api/*`, by path (for asserting what a route was sent). */
  readonly apiBodies = new Map<string, unknown[]>()
  private hosts = new Map<string, { kind: 'http' | 'ws'; count: number; methods: Set<string>; paths: Set<string>; phases: Set<string> }>()
  private csp = new Map<string, number>()
  private api = new Map<string, number>()
  private rpc = new Map<string, Map<string, number>>()
  private refusals: string[] = []
  phase = 'load'

  constructor(private readonly origin: string) {}

  private record(url: URL, method: string, kind: 'http' | 'ws') {
    const key = `${kind}:${url.host}`
    const e = this.hosts.get(key) ?? { kind, count: 0, methods: new Set<string>(), paths: new Set<string>(), phases: new Set<string>() }
    e.count++
    e.methods.add(method)
    e.phases.add(this.phase)
    if (e.paths.size < 6) e.paths.add(scrub(url.pathname))
    this.hosts.set(key, e)
  }

  /** Install on a context BEFORE the first navigation. */
  async install(context: BrowserContext) {
    await context.exposeBinding('__cspReport', (_src, directive: string, blocked: string) => {
      let host = blocked
      try {
        host = new URL(blocked).host || blocked
      } catch {}
      const key = `${directive} ${host}`
      this.csp.set(key, (this.csp.get(key) ?? 0) + 1)
    })
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        ;(window as unknown as { __cspReport?: (d: string, b: string) => void }).__cspReport?.(e.effectiveDirective, e.blockedURI)
      })
    })

    await context.route('**/*', async (route) => {
      const request = route.request()
      let url: URL
      try {
        url = new URL(request.url())
      } catch {
        return route.abort()
      }
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue()

      if (url.origin !== this.origin) {
        this.record(url, request.method(), 'http')
        // A JSON-RPC POST is answered as a healthy node for the chain its host names, so a browser that still dials a
        // provider directly shows its FULL traffic in the report, not one failed probe.
        if (request.method() === 'POST') {
          let body: unknown
          try {
            body = request.postDataJSON()
          } catch {}
          const chainHex = /base/i.test(url.host) ? '0x2105' : /arb/i.test(url.host) ? '0xa4b1' : '0x1'
          const one = (b: { id?: unknown; method?: string }) => ({ jsonrpc: '2.0', id: b?.id ?? 1, result: b?.method === 'eth_chainId' ? chainHex : '0x0' })
          if (body && typeof body === 'object' && JSON.stringify(body).includes('"jsonrpc"')) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body as { id?: unknown; method?: string })) })
          }
        }
        return route.fulfill({ status: 404, body: '' })
      }

      if (!url.pathname.startsWith('/api/')) return route.continue()

      const apiKey = url.pathname === '/api/rpc' ? `/api/rpc${url.search}` : url.pathname
      this.api.set(apiKey, (this.api.get(apiKey) ?? 0) + 1)

      if (request.method() !== 'GET' && url.pathname !== '/api/rpc') {
        let posted: unknown
        try {
          posted = request.postDataJSON()
        } catch {}
        this.apiBodies.set(url.pathname, [...(this.apiBodies.get(url.pathname) ?? []), posted])
      }
      const override = this.apiOverride?.(url, {
        method: request.method(),
        json: () => {
          try {
            return request.postDataJSON()
          } catch {
            return undefined
          }
        },
      })
      if (override) {
        try {
          return await route.fulfill({ status: override.status, contentType: 'application/json', body: JSON.stringify(override.json) })
        } catch {
          return
        }
      }

      if (url.pathname === '/api/rpc') {
        const chain = url.searchParams.get('chainId') ?? '1'
        let body: unknown
        try {
          body = request.postDataJSON()
        } catch {}
        const methods = (Array.isArray(body) ? body : [body]).map((b) => String((b as { method?: unknown })?.method ?? '?'))
        const perChain = this.rpc.get(chain) ?? new Map<string, number>()
        for (const m of methods) perChain.set(m, (perChain.get(m) ?? 0) + 1)
        this.rpc.set(chain, perChain)
        try {
          const response = await route.fetch()
          if (response.status() !== 200) this.refusals.push(`chain ${chain} ${methods.join(',')} → ${response.status()}`)
          return await route.fulfill({ response })
        } catch {
          return // the context was closed while this read was in flight (end of a scenario): nothing to answer
        }
      }

      // Every other API route: answered here, so the Next server makes no outbound call during the capture.
      if (url.pathname === '/api/token-logo' || url.pathname === '/api/proxy/logo') return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
  }

  /** JSON-RPC methods the page sent to the (mock) WalletConnect relay. */
  readonly relayMethods: string[] = []
  /** Uncaught page errors (an exception a blocked request turned into a crash would show here). */
  readonly pageErrors: string[] = []

  /**
   * Install on a page: WebSockets are per page in Playwright. Every off-origin socket is recorded and none reaches the
   * network. The WalletConnect relay is answered by a few lines of mock (subscribe / publish acknowledgements) so a
   * pairing can get as far as showing its QR code; any other socket is closed at once.
   */
  async installPage(page: Page) {
    page.on('pageerror', (error) => void this.pageErrors.push(String(error).slice(0, 200)))
    await page.routeWebSocket(/.*/, (ws) => {
      let url: URL
      try {
        url = new URL(ws.url())
      } catch {
        return void ws.close()
      }
      if (url.host === new URL(this.origin).host) return void ws.connectToServer()
      this.record(url, 'WS', 'ws')
      if (url.host !== WALLETCONNECT_RELAY_HOST) return void ws.close()
      ws.onMessage((message) => {
        let rpc: { id?: unknown; method?: string; params?: { topics?: unknown[] } }
        try {
          rpc = JSON.parse(String(message))
        } catch {
          return
        }
        if (!rpc.method || rpc.id === undefined) return
        this.relayMethods.push(rpc.method)
        const result =
          rpc.method === 'irn_subscribe'
            ? 'a'.repeat(64)
            : rpc.method === 'irn_batchSubscribe'
              ? (rpc.params?.topics ?? []).map(() => 'b'.repeat(64))
              : rpc.method === 'irn_batchFetchMessages'
                ? { messages: [], hasMore: false }
                : true
        ws.send(JSON.stringify({ id: rpc.id, jsonrpc: '2.0', result }))
      })
    })
  }

  /** End of a scenario: stop routing (in-flight handlers are let go) and close the context. */
  async close(context: BrowserContext) {
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
  }

  /** Hosts recorded so far (http and ws), de-duplicated. */
  seenHosts(): string[] {
    return [...new Set([...this.hosts.keys()].map((key) => key.slice(key.indexOf(':') + 1)))]
  }

  result(): CaptureResult {
    return {
      thirdParty: [...this.hosts].map(([key, e]) => ({
        host: key.slice(key.indexOf(':') + 1),
        kind: e.kind,
        count: e.count,
        methods: [...e.methods],
        paths: [...e.paths],
        phases: [...e.phases],
      })),
      cspBlocked: Object.fromEntries(this.csp),
      sameOriginApi: Object.fromEntries([...this.api].sort()),
      rpcMethods: Object.fromEntries([...this.rpc].map(([chain, m]) => [chain, Object.fromEntries([...m].sort())])),
      rpcRefusals: this.refusals,
    }
  }
}

export const WALLETCONNECT_RELAY_HOST = 'relay.walletconnect.org'

export const settle = (page: Page, ms: number) => page.waitForTimeout(ms)

export const MOCK_WALLET_ADDRESS = '0x000000000000000000000000000000000000dEaD'
/** What the mock wallet answers to eth_signTypedData_v4: shaped like an ECDSA signature (r ‖ s ‖ v), signs nothing. */
export const MOCK_SIGNATURE = `0x${'ab'.repeat(64)}1b`

/**
 * A browser-extension wallet that holds no key: announced over EIP-6963 (as "MetaMask") and as `window.ethereum`, it
 * answers account / chain questions, follows `wallet_switchEthereumChain` and answers `eth_signTypedData_v4` with
 * MOCK_SIGNATURE. Install BEFORE the first navigation.
 * `reconnect` makes wagmi restore it on load, like a returning visitor.
 */
export async function installMockWallet(context: BrowserContext, { reconnect = true }: { reconnect?: boolean } = {}) {
  await context.addInitScript(
    ({ address, reconnect, signature }) => {
      let chain = '0x1'
      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
      const provider = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [address]
            case 'eth_chainId':
              return chain
            case 'net_version':
              return String(parseInt(chain, 16))
            case 'wallet_switchEthereumChain':
              chain = (params?.[0] as { chainId: string }).chainId
              for (const l of listeners.chainChanged ?? []) l(chain)
              return null
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'eth_signTypedData_v4':
              // [A76 S-1] A MOCK signature (65 bytes): the CoW scenario needs the app to get past "sign"; nothing
              // that receives it ever reaches CoW (the capture answers /api/cow/* itself).
              return signature
            default:
              return null
          }
        },
        on: (event: string, l: (...a: unknown[]) => void) => void (listeners[event] ??= []).push(l),
        removeListener: (event: string, l: (...a: unknown[]) => void) => void (listeners[event] = (listeners[event] ?? []).filter((x) => x !== l)),
      }
      const info = { uuid: '00000000-0000-4000-8000-0000000000aa', name: 'MetaMask', icon: 'data:image/svg+xml;base64,PHN2Zy8+', rdns: 'io.metamask' }
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
      ;(window as unknown as { ethereum: unknown }).ethereum = provider
      if (reconnect) {
        try {
          localStorage.setItem('wagmi.recentConnectorId', '"io.metamask"')
          localStorage.setItem('wagmi.io.metamask.connected', 'true')
        } catch {}
      }
    },
    { address: MOCK_WALLET_ADDRESS, reconnect, signature: MOCK_SIGNATURE },
  )
}

/** The account label the header shows once connected: v1 `0x00…dEaD`, v2 `0x0000…dEaD` (any case, either ellipsis). */
export const CONNECTED_LABEL = /0x0{2,4}(…|\.\.\.)dead/i

/** Open the wallet picker (RainbowKit's modal in both UIs). */
export async function openConnectModal(page: Page) {
  await page.getByRole('button', { name: /connect wallet/i }).first().click({ timeout: 8_000 })
  await page.locator('[role=dialog]').first().waitFor({ state: 'visible', timeout: 8_000 })
}

/** Landing → app (both UIs open on a landing page for a first-time visitor). Best effort: a UI without one is already in the app. */
export async function launchApp(page: Page) {
  try {
    await page.getByRole('button', { name: /launch app/i }).first().click({ timeout: 4_000 })
    await settle(page, 3_000)
  } catch {}
}

/** Pick a chain in the header selector with no wallet connected (the app-level chain, which is what the read transports follow). */
export async function pickChain(page: Page, name: string) {
  await page.getByRole('button', { name: /^Network:/ }).first().click({ timeout: 5_000 })
  await page.getByRole('option', { name: new RegExp(name, 'i') }).first().click({ timeout: 5_000 })
}

/** Open the token list: the heaviest logo + balance fan-out a visitor can trigger without a wallet. */
export async function openTokenList(page: Page) {
  try {
    await page.getByRole('button', { name: /^(ETH|USDC)|Receive token|Sell token/ }).first().click({ timeout: 4_000 })
  } catch {}
}
