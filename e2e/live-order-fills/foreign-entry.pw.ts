/**
 * [A100 R2-1] A read signature cached under the WRONG wallet is never sent. v1 and v2, real browser, real CSP, the REAL
 * orders routes on the PostgREST shim; wallet stub with generated keys (wallet-rig.ts). A owns an ACTIVE DCA (2 fills);
 * B owns nothing, so A's orders stay listed after a switch to B (useOrderEngine's merge-guard).
 *
 * How such an entry comes to exist: on origin/main, an account switch while an unsigned status poll is IN FLIGHT makes the
 * new account sign a read message naming the old one, and its signature is cached under the old wallet (B's under A). The
 * tab keeps it (sessionStorage) across the deploy of a build that no longer writes them.
 *
 *   race           the audit's in-flight-poll race on the tree under test: A connected, A's signature aged out, the next
 *                  unsigned poll is held 3 s, the wallet switches to B meanwhile. On this branch: B is never asked to sign
 *                  for A, nothing of B's is cached under A, no request carries a foreign signature. (On origin/main, run
 *                  with CAPTURE_APP_DIR, this scenario FAILS: that is the race writing the entry.)
 *   preloaded      B's signature is already under A when the page loads with A connected: 0 requests carry it, A is asked
 *                  ONCE, A's fills show, what is cached under A afterwards is A's own.
 *   while-B        the entry appears under A while B is connected and A's live DCA is open: 0 requests carry it across its
 *                  fills polls (36 s); back on A, its fills show.
 *
 * The entry of `preloaded` and `while-B` is origin/main's OWN when RACE_WRITER_APP_DIR is set (the race is run on that
 * build first and the entry it left under A is handed over, in this process only); otherwise B's key signs an equivalent
 * one here. Either way it is checked to recover to B before it is used. No signature value is printed or written.
 */
import { expect, test, type Browser, type Page } from '@playwright/test'
import type { Server } from 'node:http'
import { makeExecutionRow, prng } from '../../src/test-utils/orders-db-fixture'
import type { Row } from '../../src/test-utils/fake-postgrest'
import { startPostgrestStub, type StubDb } from './postgrest-stub'
import { DB_PORT, UPSTREAM_PORT, V1_URL, V2_URL, WRITER_URLS } from './playwright.config'
import {
  KEYS, W, ageCache, cacheSignerOf, closeProbe, connectAndOpenOrders, dca, headerLabel, headerText, openProbe, plantNow, readEntry,
  settle, signedEntry, startUpstream, switchTo, txLinks, type Probe, type StoredEntry,
} from './wallet-rig'

let db: StubDb
let upstream: Server
let active: Row
let fills: Row[] = []
const LABELS: Record<string, string> = {}
const EOA = { unrecoverable: [] as Array<'A' | 'B'> }

test.beforeAll(async () => {
  const rand = prng(20261120)
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
const foreign = (p: Probe) => p.calls.filter((c) => c.sig === 'OTHER')
const crossWallet = (p: Probe) => p.prompts.filter((x) => x.signedBy !== x.messageWallet)
async function reexpand(page: Page, ui: string) {
  await toggle(page, ui).click()
  await settle(page, 800)
  await toggle(page, ui).click()
}

/**
 * The audit's in-flight-poll race, on `baseURL`: A connected and listed, A's read signature aged out, the next unsigned
 * status poll held 3 s by the browser, the wallet switched to B while it is held. Leaves the probe open in phase RACE.
 */
async function runRace(browser: Browser, ui: 'v1' | 'v2', baseURL: string): Promise<Probe> {
  const p = await openProbe(browser, baseURL, EOA, LABELS)
  const { page, result: r } = p
  const hold = { on: false, held: 0 }
  await page.route(/\/api\/orders\?.*hashes=/, async (route) => {
    if (hold.on && !route.request().headers()['x-orders-read-signature']) {
      hold.held++
      hold.on = false
      await new Promise((res) => setTimeout(res, 3_000))
    }
    await route.continue()
  })
  await connectAndOpenOrders(page, ui, baseURL)
  await expect.poll(() => headerText(page), { message: 'A is connected', timeout: 20_000 }).toMatch(headerLabel(W.A))
  await expect(toggle(page, ui), 'A\'s active DCA is listed').toBeVisible({ timeout: 30_000 })
  await expect.poll(() => cacheSignerOf(page, W.A), { message: 'A signed its own read message', timeout: 20_000 }).toBe('A')
  p.phase.v = 'RACE'
  r.cacheA = await ageCache(page, W.A)
  hold.on = true
  await page.waitForRequest((q) => /\/api\/orders\?.*hashes=/.test(q.url()) && !q.headers()['x-orders-read-signature'], { timeout: 20_000 })
  await settle(page, 500)
  await switchTo(page, KEYS.B.address)
  await expect.poll(() => headerText(page), { message: 'B is connected', timeout: 20_000 }).toMatch(headerLabel(W.B))
  // The held poll answers 401 ~3 s after it was caught; then B's own list read. Wait for the page to act on both.
  await expect.poll(() => p.prompts.filter((x) => x.phase === 'RACE' && x.signedBy === 'B' && x.messageWallet === 'B').length, { message: 'RACE: B signs its own list read', timeout: 20_000 }).toBeGreaterThan(0)
  await settle(page, 8_000)
  r.held = hold.held
  r.RACE_cacheA_signedBy = await cacheSignerOf(page, W.A)
  r.RACE_cacheB_signedBy = await cacheSignerOf(page, W.B)
  return p
}

/** The foreign entry under A: origin/main's own (its race, on the writer build) or an equivalent one signed here by B. */
async function foreignEntryUnderA(browser: Browser, ui: 'v1' | 'v2'): Promise<{ entry: StoredEntry; source: string }> {
  if (!WRITER_URLS) return { entry: await signedEntry('A', 'B'), source: 'signed in the test process by B' }
  const p = await runRace(browser, ui, WRITER_URLS[ui])
  try {
    expect(p.result.RACE_cacheA_signedBy, 'the writer build (origin/main) left B\'s signature under A in the race').toBe('B')
    const entry = await readEntry(p.page, W.A)
    expect(entry, 'the entry origin/main cached under A').not.toBeNull()
    return { entry: entry!, source: 'written by the origin/main build in the in-flight-poll race' }
  } finally {
    await closeProbe(p, `writer-race-${ui}`)
  }
}

for (const { ui, baseURL } of [{ ui: 'v1', baseURL: V1_URL }, { ui: 'v2', baseURL: V2_URL }] as const) {
  test(`${ui} · race: a switch during an in-flight unsigned poll leaves nothing of B's under A, and nothing foreign is sent`, async ({ browser }) => {
    const p = await runRace(browser, ui, baseURL)
    try {
      expect(p.result.held, 'an unsigned poll was caught in flight and held').toBe(1)
    } finally {
      await closeProbe(p, `race-${ui}`)
    }
    expect(db.unmapped, 'the PostgREST shim served every request the routes made').toEqual([])
    expect(crossWallet(p), 'no account signs a read message naming another wallet').toEqual([])
    expect(p.result.RACE_cacheA_signedBy, 'what is cached under A is not B\'s signature').not.toBe('B')
    expect(p.result.RACE_cacheB_signedBy, 'B holds its own').toBe('B')
    expect(foreign(p), 'no request carries another wallet\'s signature').toEqual([])
  })

  test(`${ui} · preloaded: B's signature already under A when the page loads: never sent, A asked once, A's fills show`, async ({ browser }) => {
    const { entry, source } = await foreignEntryUnderA(browser, ui)
    const p = await openProbe(browser, baseURL, EOA, LABELS, entry)
    const { page, result: r } = p
    r.entrySource = source
    try {
      await connectAndOpenOrders(page, ui, baseURL)
      await expect.poll(() => headerText(page), { message: 'A is connected', timeout: 20_000 }).toMatch(headerLabel(W.A))
      await expect(toggle(page, ui), 'A\'s active DCA is listed (the foreign entry did not lock A out)').toBeVisible({ timeout: 30_000 })
      await toggle(page, ui).click()
      await expect.poll(() => txLinks(page, hashes()), { message: 'A\'s active fills on the page', timeout: 20_000 }).toBe(2)
      await settle(page, 12_000) // one more 10 s poll
      r.END_cacheA_signedBy = await cacheSignerOf(page, W.A)
    } finally {
      r.promptsByPhase = await closeProbe(p, `preloaded-${ui}`)
    }
    expect(db.unmapped).toEqual([])
    expect(foreign(p), 'no request carries the foreign entry').toEqual([])
    expect(p.prompts.map((x) => `${x.requested}>${x.signedBy}/${x.messageWallet}`), 'A is asked exactly once, for its own message').toEqual(['A>A/A'])
    expect(r.END_cacheA_signedBy, 'what is cached under A afterwards is A\'s own').toBe('A')
    expect(p.calls.filter((c) => c.route === 'executions' && c.sig === 'own' && c.status === 200).length, 'A\'s fills were read with A\'s own signature').toBeGreaterThan(0)
  })

  test(`${ui} · while-B: the entry appears under A while B is connected: A's fills polls never carry it`, async ({ browser }) => {
    const { entry, source } = await foreignEntryUnderA(browser, ui)
    const p = await openProbe(browser, baseURL, EOA, LABELS)
    const { page, result: r } = p
    r.entrySource = source
    try {
      await connectAndOpenOrders(page, ui, baseURL)
      await expect.poll(() => headerText(page), { message: 'A is connected', timeout: 20_000 }).toMatch(headerLabel(W.A))
      await expect(toggle(page, ui)).toBeVisible({ timeout: 30_000 })
      await toggle(page, ui).click()
      await expect.poll(() => txLinks(page, hashes()), { message: 'P1: A\'s active fills on the page', timeout: 20_000 }).toBe(2)
      p.phase.v = 'PB'
      await switchTo(page, KEYS.B.address)
      await expect.poll(() => headerText(page), { message: 'B is connected', timeout: 20_000 }).toMatch(headerLabel(W.B))
      await expect.poll(() => p.prompts.filter((x) => x.phase === 'PB' && x.signedBy === 'B' && x.messageWallet === 'B').length, { message: 'PB: B signs its own list read', timeout: 20_000 }).toBeGreaterThan(0)
      await expect(toggle(page, ui), 'PB: A\'s active DCA is still listed while B is connected').toBeVisible({ timeout: 10_000 })
      await plantNow(page, entry)
      const before = p.calls.filter((c) => c.phase === 'PB' && c.route === 'executions').length
      await reexpand(page, ui)
      await expect.poll(() => p.calls.filter((c) => c.phase === 'PB' && c.route === 'executions').length, { message: 'PB: A\'s fills were requested after the entry appeared', timeout: 20_000 }).toBeGreaterThan(before)
      await settle(page, 36_000) // the fills refresh (30 s) and three status polls
      r.PB_fillsCallsOfA = p.calls.filter((c) => c.phase === 'PB' && c.route === 'executions' && c.urlWallet === 'A').map((c) => `${c.sig}:${c.status}`)
      r.PB_cacheA_signedBy = await cacheSignerOf(page, W.A)
      p.phase.v = 'PA'
      await switchTo(page, KEYS.A.address)
      await expect.poll(() => headerText(page), { message: 'A is connected again', timeout: 20_000 }).toMatch(headerLabel(W.A))
      await expect(toggle(page, ui)).toBeVisible({ timeout: 30_000 })
      await reexpand(page, ui)
      await expect.poll(() => txLinks(page, hashes()), { message: 'PA: A\'s active fills are back on the page', timeout: 30_000 }).toBe(2)
      await expect.poll(() => cacheSignerOf(page, W.A), { message: 'PA: the read signature cached under A is A\'s own', timeout: 10_000 }).toBe('A')
    } finally {
      r.promptsByPhase = await closeProbe(p, `while-B-${ui}`)
    }
    expect(db.unmapped).toEqual([])
    expect(foreign(p), 'no request carries the foreign entry, in any phase').toEqual([])
    expect(crossWallet(p), 'no account signs a read message naming another wallet').toEqual([])
    expect(p.prompts.filter((x) => x.phase === 'PB' && x.messageWallet === 'A'), 'while B is connected, nothing naming A is signed').toEqual([])
    expect(r.PB_cacheA_signedBy, 'the foreign entry was removed on the first read (not left under A)').not.toBe('B')
  })
}
