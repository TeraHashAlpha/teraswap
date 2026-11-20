/**
 * [A100 R2-3] A wallet whose read signature does not recover to it is asked ONCE. v1 and v2, real browser, real CSP, the
 * REAL orders routes on the PostgREST shim; wallet stub with generated keys (wallet-rig.ts). An "unrecoverable" account is
 * answered by a third key: a smart-contract-style account (Safe, Coinbase Smart Wallet), whose signature the server's
 * recover check never accepts. The audit's two cases:
 *
 *   smart-B        A (an ordinary account) connected, its live DCA open; the wallet switches to a smart-contract account B
 *                  and stays 45 s while A's order is still listed, so the 10 s status poll keeps reading as B.
 *                  Prompts in that phase: 1 on origin/main, 6 at cc282e0a (one per poll), 1 here. Then, on this branch:
 *                  "Sign to view" is showing; using it asks exactly once more; the next polls ask nothing; back on A the
 *                  state is down, A is not asked again and its fills show.
 *   smart-A-tabs   A is a smart-contract account from the start and owns a live DCA. Open Orders, cycle Swap -> Orders
 *                  twice, stay 25 s. Prompts per phase (open, cycle, stay): [1, 0, 0] on origin/main, [1, 2, 0] at
 *                  cc282e0a, [1, 0, 0] here; "Sign to view" is showing and nothing is cached under A.
 *
 * The prompt counts are asserted on EVERY tree (run origin/main with CAPTURE_APP_DIR: it passes them; cc282e0a fails them).
 * What only this branch does ("Sign to view" for such a wallet, no foreign signature ever sent) is asserted when
 * CAPTURE_APP_DIR is not set, and recorded in the report either way. No signature value is printed or written.
 */
import { expect, test, type Page } from '@playwright/test'
import type { Server } from 'node:http'
import { makeExecutionRow, prng } from '../../src/test-utils/orders-db-fixture'
import type { Row } from '../../src/test-utils/fake-postgrest'
import { startPostgrestStub, type StubDb } from './postgrest-stub'
import { DB_PORT, UPSTREAM_PORT, V1_URL, V2_URL } from './playwright.config'
import {
  KEYS, W, cacheSignerOf, closeProbe, connectAndOpenOrders, dca, headerLabel, headerText, openProbe, settle, signToView, startUpstream,
  switchTo, tab, txLinks,
} from './wallet-rig'

/** A tree other than this one is being measured (origin/main, or the round-2 head): only the prompt counts are asserted. */
const BASELINE = !!process.env.CAPTURE_APP_DIR

let db: StubDb
let upstream: Server
let active: Row
let fills: Row[] = []
const LABELS: Record<string, string> = {}

test.beforeAll(async () => {
  const rand = prng(20261121)
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
  active = dca(rand, W.A, { status: 'active', dca_total: 5, dca_executed: 2, created_at: ago(5) })
  LABELS[String(active.id)] = 'A-active'
  fills = [1, 2].map((n) => ({ ...makeExecutionRow(rand, active, n), created_at: ago(5 - n) }))
  db = await startPostgrestStub(DB_PORT, { orders: [active], order_executions: fills })
  upstream = await startUpstream(UPSTREAM_PORT)
})
test.afterAll(async () => {
  await db.close()
  await new Promise<void>((done) => upstream.close(() => done()))
})

const hashes = () => fills.map((f) => String(f.tx_hash))
const toggle = (page: Page, ui: string) => (ui === 'v2' ? page.locator(`[data-order-toggle="${active.id}"]`) : page.locator('button', { hasText: '2/5 fills' }).first())
const count = (byPhase: Record<string, number>, phases: string[]) => phases.map((p) => byPhase[p] ?? 0)

for (const { ui, baseURL } of [{ ui: 'v1', baseURL: V1_URL }, { ui: 'v2', baseURL: V2_URL }] as const) {
  test(`${ui} · smart-B: a smart-contract account switched in while A's live order stays listed is asked once, not once per poll`, async ({ browser }) => {
    const p = await openProbe(browser, baseURL, { unrecoverable: ['B'] }, LABELS)
    const { page, result: r } = p
    let byPhase: Record<string, number> = {}
    try {
      await connectAndOpenOrders(page, ui, baseURL)
      await expect.poll(() => headerText(page), { message: 'A is connected', timeout: 20_000 }).toMatch(headerLabel(W.A))
      await expect(toggle(page, ui), 'A\'s active DCA is listed').toBeVisible({ timeout: 30_000 })
      await toggle(page, ui).click()
      await expect.poll(() => txLinks(page, hashes()), { message: 'P1: A\'s active fills on the page', timeout: 20_000 }).toBe(2)

      p.phase.v = 'PB'
      const t0 = Date.now()
      await switchTo(page, KEYS.B.address)
      await expect.poll(() => headerText(page), { message: 'B is connected', timeout: 20_000 }).toMatch(headerLabel(W.B))
      await settle(page, Math.max(0, 45_000 - (Date.now() - t0))) // four status polls, as B, of A's still-listed order
      r.PB_seconds = Math.round((Date.now() - t0) / 1000)
      r.PB_activeListed = await toggle(page, ui).isVisible().catch(() => false)
      r.PB_pollsAsB = p.calls.filter((c) => c.phase === 'PB' && c.route === 'poll' && c.urlWallet === 'B').length
      r.PB_signToView = await signToView(page).isVisible().catch(() => false)
      r.PB_cacheB_signedBy = await cacheSignerOf(page, W.B)

      if (!BASELINE) {
        // "Sign to view": the one way such a wallet is asked again, once per use.
        p.phase.v = 'RETRY'
        await signToView(page).click({ timeout: 10_000 })
        await expect.poll(() => p.prompts.filter((x) => x.phase === 'RETRY').length, { message: 'RETRY: "Sign to view" asks the wallet', timeout: 15_000 }).toBe(1)
        await settle(page, 22_000) // two more status polls
        r.RETRY_signToView = await signToView(page).isVisible().catch(() => false)

        // Back on A: the state was B's; A's cached signature still reads its fills, and A is not asked again.
        p.phase.v = 'PA'
        await switchTo(page, KEYS.A.address)
        await expect.poll(() => headerText(page), { message: 'A is connected again', timeout: 20_000 }).toMatch(headerLabel(W.A))
        await expect(toggle(page, ui)).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => txLinks(page, hashes()), { message: 'PA: A\'s active fills on the page', timeout: 30_000 }).toBe(2)
        await settle(page, 12_000)
        r.PA_signToView = await signToView(page).isVisible().catch(() => false)
      }
    } finally {
      byPhase = await closeProbe(p, `smart-B-${ui}`)
    }
    expect(db.unmapped, 'the PostgREST shim served every request the routes made').toEqual([])
    expect(r.PB_activeListed, 'A\'s live order stayed listed while B was connected (so the poll kept running)').toBe(true)
    expect(r.PB_pollsAsB as number, 'the status poll ran as B several times in the 45 s').toBeGreaterThanOrEqual(3)
    expect(count(byPhase, ['P1', 'PB']), 'wallet prompts (A\'s first read; B\'s 45 s): origin/main\'s numbers').toEqual([1, 1])
    if (!BASELINE) {
      expect(r.PB_signToView, 'PB: "Sign to view" is showing for B').toBe(true)
      expect(r.PB_cacheB_signedBy, 'nothing is cached under B').toBe('absent')
      expect(count(byPhase, ['RETRY', 'PA']), '"Sign to view" asked once more; the polls after it and the switch back to A asked nothing').toEqual([1, 0])
      expect(r.RETRY_signToView, 'RETRY: still showing (the signature still does not recover)').toBe(true)
      expect(r.PA_signToView, 'PA: not showing for A, whose orders load').toBe(false)
      expect(p.calls.filter((c) => c.sig === 'OTHER'), 'no request ever carries a signature that is not its wallet\'s own').toEqual([])
      expect(p.prompts.filter((x) => x.requested !== x.messageWallet), 'no account is asked to sign a message naming another wallet').toEqual([])
    }
  })

  test(`${ui} · smart-A-tabs: a smart-contract account from the start is asked once across two Orders tab cycles`, async ({ browser }) => {
    const p = await openProbe(browser, baseURL, { unrecoverable: ['A'] }, LABELS)
    const { page, result: r } = p
    let byPhase: Record<string, number> = {}
    try {
      await connectAndOpenOrders(page, ui, baseURL)
      await expect.poll(() => headerText(page), { message: 'A is connected', timeout: 20_000 }).toMatch(headerLabel(W.A))
      await expect.poll(() => p.prompts.length, { message: 'P1: the first read asks the wallet', timeout: 20_000 }).toBeGreaterThan(0)
      await settle(page, 8_000)
      r.OPEN_signToView = await signToView(page).isVisible().catch(() => false)
      p.phase.v = 'CYCLE'
      for (let i = 0; i < 2; i++) {
        await tab(page, ui, 'swap').click({ timeout: 8_000 })
        await settle(page, 2_000)
        await tab(page, ui, 'orders').click({ timeout: 8_000 })
        await settle(page, 5_000)
      }
      r.CYCLE_listReads = p.calls.filter((c) => c.phase === 'CYCLE' && c.route === 'list').length
      p.phase.v = 'STAY'
      await settle(page, 25_000)
      r.END_signToView = await signToView(page).isVisible().catch(() => false)
      r.END_cacheA_signedBy = await cacheSignerOf(page, W.A)
    } finally {
      byPhase = await closeProbe(p, `smart-A-tabs-${ui}`)
    }
    expect(db.unmapped).toEqual([])
    expect(r.CYCLE_listReads as number, 'each return to the Orders tab read the list again').toBeGreaterThanOrEqual(2)
    expect(count(byPhase, ['P1', 'CYCLE', 'STAY']), 'wallet prompts (open, two tab cycles, 25 s): origin/main\'s numbers').toEqual([1, 0, 0])
    if (!BASELINE) {
      expect([r.OPEN_signToView, r.END_signToView], '"Sign to view" is showing after the first read and at the end').toEqual([true, true])
      expect(r.END_cacheA_signedBy, 'nothing is cached under A').toBe('absent')
      expect(p.calls.filter((c) => c.sig === 'OTHER'), 'no request ever carries a signature that is not its wallet\'s own').toEqual([])
    }
  })
}
