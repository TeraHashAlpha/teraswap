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

export class Capture {
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
        const response = await route.fetch()
        if (response.status() !== 200) this.refusals.push(`chain ${chain} ${methods.join(',')} → ${response.status()}`)
        return route.fulfill({ response })
      }

      // Every other API route: answered here, so the Next server makes no outbound call during the capture.
      if (url.pathname === '/api/token-logo' || url.pathname === '/api/proxy/logo') return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
  }

  /** Install on a page: WebSockets are per page in Playwright. */
  async installPage(page: Page) {
    await page.routeWebSocket(/.*/, (ws) => {
      try {
        const url = new URL(ws.url())
        if (url.host !== new URL(this.origin).host) this.record(url, 'WS', 'ws')
      } catch {}
      ws.close()
    })
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

export const settle = (page: Page, ms: number) => page.waitForTimeout(ms)

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
