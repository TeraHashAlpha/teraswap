/**
 * [fix/user-ip-privacy A76 S-1] CoW submit AFTER signing: the one moment a host capture that never swaps cannot see.
 *
 * Until A76 the browser itself POSTed the signed CoW order to api.cow.fi and polled its status and trades there —
 * which handed CoW the visitor's IP, and which the site's CSP (connect-src has no CoW host) refuses. This drives v1 and
 * v2 on Ethereum through a whole CoW swap with an extension wallet (mock, MOCK_SIGNATURE) under the REAL CSP:
 * USDC → ETH, quote, review, "Confirm & Sign Order", submit, poll, settled. The browser must reach /api/cow/orders,
 * /api/cow/order-status and /api/cow/trades on our own origin, contact no third-party host, and have nothing refused.
 *
 * Nothing leaves the machine: cow-flow.ts answers /api/rpc, /api/quote, /api/swap and /api/cow/* (CoW's side of
 * the relay is covered by src/app/api/cow/cow-routes.test.ts).
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { V1_URL, V2_URL } from './playwright.config'
import { INJECTED_WALLET_ALLOWED_HOSTS } from './allow-list'
import { Capture, CONNECTED_LABEL, installMockWallet, launchApp, MOCK_SIGNATURE, MOCK_WALLET_ADDRESS, settle } from './rig'
import { cowFlowOverride, COW_ORDER_UID } from './cow-flow'

/** Fields of a signed GPv2 order the relay forwards (src/lib/cow-proxy.ts pickSignedOrder). */
const SIGNED_ORDER_FIELDS = [
  'appData', 'appDataHash', 'buyAmount', 'buyToken', 'buyTokenBalance', 'feeAmount', 'from', 'kind', 'partiallyFillable',
  'quoteId', 'receiver', 'sellAmount', 'sellToken', 'sellTokenBalance', 'signature', 'signingScheme', 'validTo',
]

const UIS = [
  {
    ui: 'v1',
    baseURL: V1_URL,
    flip: (page: Page) => page.locator('button', { hasText: '⇅' }).first(),
    amount: (page: Page) => page.getByPlaceholder('0.0').first(),
    // The nav tab is also a button named "Swap": the CTA is the second one, once the quote and approval are ready.
    ctaReady: async (page: Page) => expect(page.getByRole('button', { name: /^Swap$/ })).toHaveCount(2, { timeout: 30_000 }),
    cta: (page: Page) => page.getByRole('button', { name: /^Swap$/ }).last(),
  },
  {
    ui: 'v2',
    baseURL: V2_URL,
    flip: (page: Page) => page.getByRole('button', { name: 'Swap sell and receive tokens' }).first(),
    amount: (page: Page) => page.getByRole('textbox', { name: 'Sell amount' }).first(),
    ctaReady: async () => {},
    cta: (page: Page) => page.getByRole('button', { name: /^Review swap$/ }).first(),
  },
] as const

function writeReport(name: string, report: unknown) {
  if (!process.env.CAPTURE_OUT) return
  mkdirSync(process.env.CAPTURE_OUT, { recursive: true })
  writeFileSync(join(process.env.CAPTURE_OUT, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`)
}

for (const { ui, baseURL, flip, amount, ctaReady, cta } of UIS) {
  test(`${ui} · CoW submit after signing (mock signature): order, status and trades go to our origin; no third-party host, nothing refused`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const capture = new Capture(new URL(baseURL).origin)
    capture.apiOverride = cowFlowOverride
    await capture.install(context)
    await installMockWallet(context)
    const page = await context.newPage()
    await capture.installPage(page)

    capture.phase = 'connect'
    await page.goto(`${baseURL}/`, { waitUntil: 'load' })
    await settle(page, 3_000)
    await launchApp(page)
    await expect.poll(() => page.locator('header').first().innerText(), { message: 'the mock wallet reconnected', timeout: 15_000 }).toMatch(CONNECTED_LABEL)

    capture.phase = 'quote'
    await flip(page).click({ timeout: 8_000 })
    await settle(page, 1_000)
    await amount(page).fill('5')
    await ctaReady(page)
    const button = cta(page)
    await expect(button, 'the swap button is ready (CoW is the best quote, nothing blocks it)').toBeEnabled({ timeout: 30_000 })

    capture.phase = 'sign + submit'
    await button.click()
    // v1: CoW review modal. v2: review sheet first when the lifecycle opens one, then the CoW review sheet. The waits do
    // not throw: whatever happened is reported first, so a regression fails on WHAT the browser tried (e.g. a refused
    // `connect-src api.cow.fi`), not on a timeout.
    const until = async (done: () => Promise<boolean> | boolean, ms: number) => {
      for (const end = Date.now() + ms; Date.now() < end; await settle(page, 500)) if (await done()) return true
      return false
    }
    const count = (path: string) => capture.result().sameOriginApi[path] ?? 0
    const refused = () => Object.keys(capture.result().cspBlocked).length > 0
    await until(async () => {
      if (count('/api/cow/orders') > 0 || refused()) return true
      for (const confirm of [page.getByRole('button', { name: /confirm & sign order/i }), page.getByTestId('review-confirm')]) {
        if (await confirm.first().isVisible().catch(() => false)) await confirm.first().click().catch(() => {})
      }
      return false
    }, 40_000)
    capture.phase = 'poll'
    await until(() => count('/api/cow/trades') > 0 || refused(), 30_000)
    await settle(page, 2_000)

    const result = capture.result()
    const submitted = (capture.apiBodies.get('/api/cow/orders') ?? []) as Array<Record<string, unknown>>
    writeReport(`cow-submit-${ui}`, { ui, wallet: 'extension (mock)', ...result, submittedFields: submitted.map((b) => Object.keys(b ?? {}).sort()), pageErrors: capture.pageErrors })
    await capture.close(context)

    expect(result.cspBlocked, 'requests the CSP had to refuse (before A76: connect-src api.cow.fi — the signed order)').toEqual({})
    expect(result.thirdParty.filter((h) => !INJECTED_WALLET_ALLOWED_HOSTS.includes(h.host)), 'third-party hosts contacted during a CoW swap').toEqual([])
    expect(result.sameOriginApi['/api/cow/orders'] ?? 0, 'one signed order, submitted through our origin').toBe(1)
    expect(result.sameOriginApi['/api/cow/order-status'] ?? 0, 'its status, polled through our origin').toBeGreaterThan(0)
    expect(result.sameOriginApi['/api/cow/trades'] ?? 0, 'its settlement, read through our origin').toBeGreaterThan(0)
    expect(submitted[0]?.signature, 'the wallet’s (mock) signature is what was submitted').toBe(MOCK_SIGNATURE)
    expect(String(submitted[0]?.from).toLowerCase()).toBe(MOCK_WALLET_ADDRESS.toLowerCase())
    expect(Object.keys(submitted[0] ?? {}).sort(), 'the browser sends exactly the signed-order fields the relay forwards').toEqual(SIGNED_ORDER_FIELDS)
    expect(COW_ORDER_UID).toMatch(/^0x[0-9a-f]{112}$/)
  })
}
