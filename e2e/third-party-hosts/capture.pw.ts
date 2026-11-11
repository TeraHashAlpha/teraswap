/**
 * [fix/user-ip-privacy] "A page load with no wallet makes 0 third-party requests" — measured, for v1 and v2 on all three
 * chains, in real Chromium under the site's real CSP.
 *
 * A visitor with no wallet: open the site, enter the app, pick the chain, open the token list, leave the tab idle. Every
 * request to another origin is recorded (rig.ts) and the run fails if any host is outside the allow-list — which for a
 * wallet-less visitor is empty. It also fails if the site's own CSP had to stop something (an attempt is a bug even when
 * the browser never sent it), and if `/api/rpc` refused a method the app itself sent.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { V1_URL, V2_URL } from './playwright.config'
import { NO_WALLET_ALLOWED_HOSTS } from './allow-list'
import { Capture, launchApp, openTokenList, pickChain, settle } from './rig'

const UIS = [
  { ui: 'v1', baseURL: V1_URL },
  { ui: 'v2', baseURL: V2_URL },
] as const
const CHAINS = [
  { name: 'Ethereum', id: 1 },
  { name: 'Base', id: 8453 },
  { name: 'Arbitrum', id: 42161 },
] as const

for (const { ui, baseURL } of UIS) {
  for (const chain of CHAINS) {
    test(`${ui} · ${chain.name} · no wallet: the browser contacts no third-party host`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
      const capture = new Capture(new URL(baseURL).origin)
      await capture.install(context)
      const page = await context.newPage()
      await capture.installPage(page)

      capture.phase = 'load'
      await page.goto(`${baseURL}/`, { waitUntil: 'load' })
      await settle(page, 5_000)
      await launchApp(page)

      capture.phase = 'chain'
      if (chain.id !== 1) await pickChain(page, chain.name)
      await settle(page, 6_000)

      capture.phase = 'token list'
      await openTokenList(page)
      await settle(page, 4_000)

      capture.phase = 'idle'
      await settle(page, 6_000)

      const result = capture.result()
      const report = { ui, chain: chain.name, chainId: chain.id, ...result }
      if (process.env.CAPTURE_OUT) {
        mkdirSync(process.env.CAPTURE_OUT, { recursive: true })
        writeFileSync(join(process.env.CAPTURE_OUT, `no-wallet-${ui}-${chain.id}.json`), `${JSON.stringify(report, null, 1)}\n`)
      }
      await capture.close(context)

      // The run really exercised the app on the chain under test (not a blank page that trivially contacts nobody).
      const rpcKey = chain.id === 1 ? '/api/rpc' : `/api/rpc?chainId=${chain.id}`
      expect(result.sameOriginApi[rpcKey] ?? 0, `the app must have read ${chain.name} through ${rpcKey}`).toBeGreaterThan(0)

      const offenders = result.thirdParty.filter((h) => !NO_WALLET_ALLOWED_HOSTS.includes(h.host))
      expect(offenders, 'third-party hosts contacted by a wallet-less visitor').toEqual([])
      expect(result.cspBlocked, 'requests the CSP had to refuse').toEqual({})
      expect(result.rpcRefusals, '/api/rpc refused a method the app itself sent').toEqual([])
    })
  }
}
