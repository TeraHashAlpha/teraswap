/**
 * [fix/privacy-no-usage-tracking A78 S-1/S-4] What a wallet-less visitor's QUOTES send to /api/log-quote, measured in
 * real Chromium against the production build, for v1 and v2.
 *
 * The other captures answer every `/api/*` call with `{}`, so no quote ever succeeded there and a "0 log requests" figure
 * proved nothing. Here /api/quote returns a valid, request-echoing meta-quote, so the quote hook really stores it and the
 * logger WOULD fire. Two counts are asserted:
 *
 *   1. Landing preview, no wallet, 35 s (the first quote + two 15 s refreshes): quotes succeed, /api/log-quote = 0.
 *   2. Swap screen, no wallet, an amount typed: the quote succeeds and /api/log-quote = 1, whose body has no wallet,
 *      session, device or referrer field.
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { V1_URL, V2_URL } from './playwright.config'
import { Capture, launchApp, settle, type ApiOverride } from './rig'

const UIS = [
  { ui: 'v1', baseURL: V1_URL, amount: (page: Page) => page.getByPlaceholder('0.0').first() },
  { ui: 'v2', baseURL: V2_URL, amount: (page: Page) => page.getByRole('textbox', { name: 'Sell amount' }).first() },
] as const

/** A valid meta-quote for whatever pair/amount is asked: 1 input unit → 1 output unit, two sources answering. */
const validQuote: ApiOverride = (url) => {
  if (url.pathname !== '/api/quote') return null
  const q = url.searchParams
  const decimalsIn = Number(q.get('srcDecimals') ?? '18')
  const decimalsOut = Number(q.get('dstDecimals') ?? '18')
  const amount = q.get('amount') ?? '0'
  const out = (BigInt(amount) * 10n ** BigInt(decimalsOut) / 10n ** BigInt(decimalsIn)).toString()
  const best = { source: '1inch', toAmount: out, estimatedGas: 150000, gasUsd: 5, routes: ['stub'] }
  const second = { source: 'paraswap', toAmount: (BigInt(out) - 1n).toString(), estimatedGas: 160000, gasUsd: 5, routes: ['stub'] }
  return {
    status: 200,
    json: { best, all: [best, second], fetchedAt: Date.now(), tokenIn: q.get('src'), tokenOut: q.get('dst'), chainId: Number(q.get('chainId') ?? '1'), decimalsIn, decimalsOut, amountIn: amount },
  }
}

const FORBIDDEN_FIELD = /wallet|session|device|referrer|referer|userAgent|ip\b/i

for (const { ui, baseURL, amount } of UIS) {
  test(`${ui} · no wallet: the landing preview quote is never logged; a swap-screen quote is logged once, without an identifier`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const capture = new Capture(new URL(baseURL).origin)
    capture.apiOverride = validQuote
    await capture.install(context)
    const page = await context.newPage()
    await capture.installPage(page)

    capture.phase = 'landing'
    await page.goto(`${baseURL}/`, { waitUntil: 'load' })
    await settle(page, 35_000)
    const landing = capture.result().sameOriginApi
    const landingQuotes = landing['/api/quote'] ?? 0
    const landingLogs = landing['/api/log-quote'] ?? 0

    capture.phase = 'swap screen'
    await launchApp(page)
    const before = capture.result().sameOriginApi['/api/quote'] ?? 0
    await amount(page).fill('1', { timeout: 10_000 })
    await settle(page, 6_000)
    const after = capture.result().sameOriginApi
    const swapQuotes = (after['/api/quote'] ?? 0) - before
    const swapLogs = (after['/api/log-quote'] ?? 0) - landingLogs
    const bodies = (capture.apiBodies.get('/api/log-quote') ?? []) as Array<Record<string, unknown>>

    if (process.env.CAPTURE_OUT) {
      mkdirSync(process.env.CAPTURE_OUT, { recursive: true })
      writeFileSync(
        join(process.env.CAPTURE_OUT, `quote-logging-${ui}.json`),
        `${JSON.stringify({ ui, landing: { quoteRequests: landingQuotes, logQuoteRequests: landingLogs }, swapScreen: { quoteRequests: swapQuotes, logQuoteRequests: swapLogs, bodyFields: bodies.map((b) => Object.keys(b ?? {}).sort()) } }, null, 1)}\n`,
      )
    }
    await capture.close(context)

    expect(landingQuotes, 'the landing preview really fetched quotes (first + 15 s refreshes)').toBeGreaterThanOrEqual(3)
    expect(landingLogs, 'the landing preview quote is not logged').toBe(0)
    expect(swapQuotes, 'the swap screen fetched a quote for the typed amount').toBeGreaterThanOrEqual(1)
    expect(swapLogs, 'one swap-screen quote → one log request').toBe(swapQuotes)
    expect(swapLogs).toBe(1)
    expect(bodies).toHaveLength(1)
    expect(Object.keys(bodies[0]).filter((k) => FORBIDDEN_FIELD.test(k)), 'no wallet / session / device / referrer field').toEqual([])
    expect(Object.keys(bodies[0]).sort()).toEqual([
      'allQuotes', 'amountIn', 'bestAmountOut', 'bestSource', 'responseTimeMs',
      'sourcesQueried', 'sourcesResponded', 'tokenIn', 'tokenInSymbol', 'tokenOut', 'tokenOutSymbol',
    ])
  })
}
