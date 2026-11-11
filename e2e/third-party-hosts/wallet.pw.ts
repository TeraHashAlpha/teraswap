/**
 * [fix/user-ip-privacy] After a wallet is chosen: the connector still works under the real CSP, and the browser contacts
 * only the hosts that wallet needs.
 *
 *  1. A browser-extension wallet (mock, EIP-6963): connects, follows a chain switch, and on every chain and tab the page
 *     itself still talks to our origin only — the extension does its own networking.
 *  2. WalletConnect: with WalletConnect / Reown telemetry refused by the CSP, pairing still reaches the relay and shows
 *     its QR code, and WalletConnect's own modal still opens. The only hosts contacted are the WalletConnect ones in the
 *     CSP; the only things the CSP refuses are the two it is meant to (allow-list.ts).
 *
 * Nothing leaves the machine: the relay is a mock (rig.ts), every other off-origin request is answered locally.
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { V1_URL, V2_URL } from './playwright.config'
import { EXPECTED_CSP_REFUSALS_WITH_WALLETCONNECT, INJECTED_WALLET_ALLOWED_HOSTS, WALLETCONNECT_ALLOWED_HOSTS } from './allow-list'
import { Capture, CONNECTED_LABEL, installMockWallet, launchApp, openConnectModal, openTokenList, pickChain, settle, WALLETCONNECT_RELAY_HOST } from './rig'

const UIS = [
  { ui: 'v1', baseURL: V1_URL, tabs: [] as string[] },
  // v2 has one route per tab; the order / portfolio tabs are where a connected wallet's own reads happen.
  { ui: 'v2', baseURL: V2_URL, tabs: ['/portfolio', '/dca', '/orders', '/history'] },
] as const

function writeReport(name: string, report: unknown) {
  if (!process.env.CAPTURE_OUT) return
  mkdirSync(process.env.CAPTURE_OUT, { recursive: true })
  writeFileSync(join(process.env.CAPTURE_OUT, `${name}.json`), `${JSON.stringify(report, null, 1)}\n`)
}

const headerText = (page: Page) => page.locator('header').first().innerText()

for (const { ui, baseURL, tabs } of UIS) {
  test(`${ui} · extension wallet (mock): connects under the real CSP and the page contacts no third-party host`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const capture = new Capture(new URL(baseURL).origin)
    await capture.install(context)
    await installMockWallet(context)
    const page = await context.newPage()
    await capture.installPage(page)

    capture.phase = 'connect'
    await page.goto(`${baseURL}/`, { waitUntil: 'load' })
    await settle(page, 4_000)
    await launchApp(page)
    // A returning wallet reconnects on load; if the UI still offers "Connect Wallet", go through the picker like a first visit.
    if (!CONNECTED_LABEL.test(await headerText(page))) {
      await openConnectModal(page)
      await page.locator('[role=dialog]').getByText('MetaMask', { exact: true }).first().click({ timeout: 8_000 })
    }
    await expect.poll(() => headerText(page), { message: 'the header shows the connected account', timeout: 15_000 }).toMatch(CONNECTED_LABEL)

    for (const chain of ['Base', 'Arbitrum', 'Ethereum']) {
      capture.phase = chain
      await pickChain(page, chain)
      await expect.poll(() => headerText(page), { message: `the wallet followed the switch to ${chain}`, timeout: 10_000 }).toMatch(new RegExp(chain, 'i'))
      await settle(page, 5_000)
    }
    // The token list (balances for the connected wallet) — last, because v1's selector is a full-screen overlay that
    // would sit on top of the chain picker. The wallet-less capture opens it on every chain.
    capture.phase = 'token list'
    await openTokenList(page)
    await settle(page, 4_000)
    for (const tab of tabs) {
      capture.phase = `tab ${tab}`
      await page.goto(`${baseURL}${tab}`, { waitUntil: 'load' })
      await settle(page, 5_000)
    }

    const result = capture.result()
    writeReport(`extension-wallet-${ui}`, { ui, wallet: 'extension (mock)', ...result, pageErrors: capture.pageErrors })
    await capture.close(context)

    expect(result.sameOriginApi['/api/rpc?chainId=8453'] ?? 0, 'Base was read through our proxy').toBeGreaterThan(0)
    expect(result.sameOriginApi['/api/rpc?chainId=42161'] ?? 0, 'Arbitrum was read through our proxy').toBeGreaterThan(0)
    expect(result.thirdParty.filter((h) => !INJECTED_WALLET_ALLOWED_HOSTS.includes(h.host)), 'third-party hosts contacted with an extension wallet connected').toEqual([])
    expect(result.cspBlocked, 'requests the CSP had to refuse').toEqual({})
    expect(result.rpcRefusals, '/api/rpc refused a method the app itself sent').toEqual([])
  })

  test(`${ui} · WalletConnect chosen: pairing reaches the relay and shows a QR code with telemetry refused; only WalletConnect hosts are contacted`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const capture = new Capture(new URL(baseURL).origin)
    await capture.install(context)
    const page = await context.newPage()
    await capture.installPage(page)

    capture.phase = 'load'
    await page.goto(`${baseURL}/`, { waitUntil: 'load' })
    await settle(page, 4_000)
    await launchApp(page)
    await openConnectModal(page)
    expect(capture.seenHosts(), 'opening the wallet picker contacts nobody').toEqual([])

    capture.phase = 'WalletConnect QR'
    const dialog = page.locator('[role=dialog]').first()
    await dialog.getByText('WalletConnect', { exact: true }).first().click({ timeout: 8_000 })
    await expect(dialog.getByText(/scan with your phone/i), 'the QR pairing view').toBeVisible({ timeout: 20_000 })
    // The QR itself is drawn only once the relay acknowledged the pairing topic: the connector works end to end up to the wallet.
    await expect.poll(() => capture.relayMethods, { message: 'the pairing was published to the relay', timeout: 20_000 }).toEqual(expect.arrayContaining(['irn_subscribe', 'irn_publish']))
    await expect.poll(async () => dialog.locator('svg').evaluateAll((svgs) => svgs.filter((s) => s.getBoundingClientRect().width > 150).length), { message: 'a QR code is drawn', timeout: 20_000 }).toBeGreaterThan(0)
    const afterQr = capture.seenHosts()

    capture.phase = 'WalletConnect modal'
    await dialog.getByText(/^open$/i).first().click({ timeout: 8_000 })
    await expect.poll(() => page.locator('w3m-modal').count(), { message: "WalletConnect's own modal is created", timeout: 20_000 }).toBeGreaterThan(0)
    await settle(page, 6_000)

    const result = capture.result()
    writeReport(`walletconnect-${ui}`, { ui, wallet: 'WalletConnect', hostsAfterQr: afterQr, relayMethods: [...new Set(capture.relayMethods)], ...result, pageErrors: capture.pageErrors })
    await capture.close(context)

    expect(afterQr, 'the QR connector contacts the relay and nothing else').toEqual([WALLETCONNECT_RELAY_HOST])
    expect(result.thirdParty.map((h) => h.host).filter((h) => !WALLETCONNECT_ALLOWED_HOSTS.includes(h)), 'hosts outside the WalletConnect allow-list').toEqual([])
    expect(result.thirdParty.map((h) => h.host), 'telemetry was never sent').not.toContain('pulse.walletconnect.org')
    expect(Object.keys(result.cspBlocked).filter((k) => !EXPECTED_CSP_REFUSALS_WITH_WALLETCONNECT.includes(k)), 'unexpected CSP refusals').toEqual([])
    expect(capture.pageErrors, 'no uncaught error — a refused telemetry request must not break the page').toEqual([])
  })
}
