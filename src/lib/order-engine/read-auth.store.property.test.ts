// @vitest-environment jsdom
/**
 * [A97 S-1] Property: the browser's read-signature cache only ever holds a wallet's OWN signature under that wallet.
 *
 * Seeded random sequences over three accounts mix:
 *   - ensureOrdersReadAuth(W, signer) with a signer that signs as a random account (W itself or another), returns a
 *     malformed value, throws a refusal, or throws "not the connected account";
 *   - fetchOrderExecutions(id, W, { live }) through the registry, with a random account connected;
 *   - planting an entry under W signed by ANOTHER account (what 302f9cec could write: B's signature cached under A);
 *   - retryOrdersReadAuth(W).
 * After every step: every cached entry recovers to its own key, except one planted and not read since; after
 * ensureOrdersReadAuth(W) the entry under W (if any) recovers to W ('ok' means it is there). A refusal is recorded only
 * when the signer refused or returned garbage, never for "another account signed" or "not connected".
 * Not vacuous: each seed stores own signatures, refuses foreign ones, drops planted ones and records refusals.
 * A failing step names its seed and step, never a signature value.
 *
 * [A100 R2-1] And nothing foreign is ever SENT: the mock server notes every request whose read headers do not recover to
 * the wallet its URL names (there must be none, in any step), and a planted entry is gone after ANY fills read of its
 * wallet, the owner connected or not. Not vacuous: each seed reads a planted entry with its owner not connected.
 *
 * [A100 R2-3] "Another account signed" (and a 0x value that is no signature) is now the remembered outcome 'mismatch', no
 * longer 'unavailable'. CHANGED EXPECTATION (owner, 2026-11-20): the counter `refusedForeign` counted `'unavailable'` for a
 * signer answering as another account; it counts `'mismatch'`, and `'unavailable'` from any signer but the one that says
 * "not connected" is now a failure. Added: a wallet that is remembered (refused, or mismatch) is never prompted until
 * retryOrdersReadAuth, by ensureOrdersReadAuth or by a fills read; a mismatch is remembered only for those two signers;
 * a fills read never prompts an account for another wallet. Not vacuous: each seed reads a remembered-mismatch wallet.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  _readAuthInternal,
  buildOrdersReadTypedData,
  ensureOrdersReadAuth,
  getCachedOrdersReadAuth,
  OrdersReadSignerUnavailableError,
  retryOrdersReadAuth,
  setOrdersReadSigner,
  storeOrdersReadAuth,
  verifyOrdersReadAccess,
  type SignTypedDataFn,
} from './read-auth'
import { fetchOrderExecutions } from './executions-client'
import { prng } from '@/test-utils/orders-db-fixture'

// Anvil #0 (value-allowlisted in .gitleaks.toml, NOT a secret) + two generated per run; drawn by INDEX so a seed replays.
const KEYS = [
  privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
  privateKeyToAccount(generatePrivateKey()),
  privateKeyToAccount(generatePrivateKey()),
]
const WALLETS = KEYS.map((k) => k.address)
const SEEDS = [3, 97, 2026, 11191, 20261119] as const
// [A100 R2-3] 60 -> 120. A remembered mismatch stops the prompts a later refusal needs, so seed 3's first 60 steps no longer
// record any refusal (its `refusalsRecorded` counter was 0). The walk is LONGER, not different: the same seeds, and each
// seed's first 60 steps are the ones round 2 ran; every assertion and counter is kept.
const STEPS = 120

const SIGNERS = ['self', 'other', 'garbage', 'refuse', 'unavailable'] as const
type SignerKind = (typeof SIGNERS)[number]

function makeSigner(kind: SignerKind, w: number, rand: () => number): SignTypedDataFn {
  switch (kind) {
    case 'self':
      return async (typed) => KEYS[w].signTypedData(typed)
    case 'other':
      return async (typed) => KEYS[(w + 1 + Math.floor(rand() * 2)) % 3].signTypedData(typed)
    case 'garbage':
      return async () => (rand() < 0.5 ? '0x1234' : 'not-a-signature')
    case 'refuse':
      return async () => {
        throw new Error('User rejected the request')
      }
    case 'unavailable':
      return async () => {
        throw new OrdersReadSignerUnavailableError()
      }
  }
}

/** [A100 R2-3] Count the prompts a signer gets. */
function counted(sign: SignTypedDataFn, calls: { n: number }): SignTypedDataFn {
  return async (typed) => {
    calls.n++
    return sign(typed)
  }
}
const remembered = (wallet: string) => _readAuthInternal.isDenied(wallet) || _readAuthInternal.isMismatched(wallet)

const recoversTo = async (wallet: string, e: { issuedAt: number; signature: string }) =>
  (await verifyOrdersReadAccess({ wallet, issuedAt: e.issuedAt, signature: e.signature })).ok

const fetchMock = vi.fn()
/** [A100 R2-1] Requests whose read headers were NOT the URL wallet's own signature (the path only; never the value). */
let foreignSent: string[] = []
beforeEach(() => {
  sessionStorage.clear()
  _readAuthInternal.reset()
  _readAuthInternal.clearSigner()
  foreignSent = []
  vi.stubGlobal('fetch', fetchMock)
  // The server: 200 only with the named wallet's own valid read signature on a live order, else 401.
  fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
    const wallet = new URL(url, 'http://x').searchParams.get('wallet')!
    const h = init?.headers
    const okSig = h ? await recoversTo(wallet, { issuedAt: Number(h['x-orders-read-issued']), signature: h['x-orders-read-signature'] }) : false
    if (h && !okSig) foreignSent.push(new URL(url, 'http://x').pathname)
    return okSig ? { status: 200, ok: true, json: async () => ({}) } : { status: 401, ok: false, json: async () => ({}) }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('property: a cached read signature always recovers to the wallet it is cached under', () => {
  it.each(SEEDS)('seed %i', async (seed) => {
    const rand = prng(seed)
    const failures: string[] = []
    const planted = new Set<number>()
    const seen = { storedOwn: 0, refusedForeign: 0, droppedPlanted: 0, refusalsRecorded: 0, notConnected: 0, plantedReadNotConnected: 0, mismatchNotReasked: 0 }
    const owner = {}

    for (let step = 0; step < STEPS; step++) {
      const w = Math.floor(rand() * 3)
      const op = rand()
      const label = `seed ${seed} step ${step}`
      if (op < 0.4) {
        const kind = SIGNERS[Math.floor(rand() * SIGNERS.length)]
        const deniedBefore = _readAuthInternal.isDenied(WALLETS[w])
        const mismatchBefore = _readAuthInternal.isMismatched(WALLETS[w])
        const hadPlant = planted.has(w)
        const prompts = { n: 0 }
        const out = await ensureOrdersReadAuth(WALLETS[w], counted(makeSigner(kind, w, rand), prompts))
        // [A100 R2-3] A remembered wallet is not prompted; a mismatch is remembered only for a signature that does not recover.
        if ((deniedBefore || mismatchBefore) && prompts.n > 0) failures.push(`${label}: ensure(${kind}) prompted a remembered wallet`)
        if (mismatchBefore && prompts.n === 0 && out === 'mismatch') seen.mismatchNotReasked++
        if (!mismatchBefore && _readAuthInternal.isMismatched(WALLETS[w]) && kind !== 'other' && kind !== 'garbage') failures.push(`${label}: a mismatch was remembered for ${kind}`)
        if (out === 'unavailable' && kind !== 'unavailable') failures.push(`${label}: ensure(${kind}) said unavailable, which only the not-connected signer may cause`)
        if (kind === 'other' && prompts.n > 0 && out !== 'mismatch') failures.push(`${label}: another account answered the prompt and the outcome was ${out}`)
        if (hadPlant) {
          planted.delete(w)
          if (!getCachedOrdersReadAuth(WALLETS[w]) || out === 'ok') seen.droppedPlanted++
        }
        const entry = getCachedOrdersReadAuth(WALLETS[w])
        if (entry && !(await recoversTo(WALLETS[w], entry))) failures.push(`${label}: ensure(${kind}) left a foreign entry`)
        if (out === 'ok' && !entry) failures.push(`${label}: ensure(${kind}) said ok with nothing cached`)
        if (kind === 'other' && prompts.n > 0 && out === 'mismatch') seen.refusedForeign++ // was: out === 'unavailable' (see the header)
        if (kind === 'self' && out === 'ok') seen.storedOwn++
        const deniedAfter = _readAuthInternal.isDenied(WALLETS[w])
        if (!deniedBefore && deniedAfter) {
          seen.refusalsRecorded++
          if (kind !== 'refuse' && kind !== 'garbage') failures.push(`${label}: a refusal was recorded for ${kind}`)
        }
      } else if (op < 0.65) {
        // The Orders tab with a random account connected (or none), the fills of W's live order.
        const c = Math.floor(rand() * 4) // 3 = nothing connected
        const kind = SIGNERS[Math.floor(rand() * 3)] // self / other / garbage
        const prompts = { n: 0 }
        setOrdersReadSigner(owner, c < 3 ? { address: WALLETS[c], sign: counted(makeSigner(kind, c, rand), prompts) } : null)
        const deniedBefore = _readAuthInternal.isDenied(WALLETS[w])
        const rememberedBefore = remembered(WALLETS[w])
        const mismatchBefore = _readAuthInternal.isMismatched(WALLETS[w])
        const hadPlant = planted.has(w)
        await fetchOrderExecutions(`order-${step}`, WALLETS[w], { live: rand() < 0.7 })
        // [A100 R2-3] A fills read prompts nobody for a remembered wallet, and never the connected account for another wallet.
        if (rememberedBefore && prompts.n > 0) failures.push(`${label}: a fills read prompted a remembered wallet`)
        if (c !== w && prompts.n > 0) failures.push(`${label}: a fills read of wallet #${w} prompted account #${c}`)
        if (c === w && mismatchBefore && prompts.n === 0) seen.mismatchNotReasked++
        if (c !== w) {
          seen.notConnected++
          if (hadPlant) seen.plantedReadNotConnected++
          if (!deniedBefore && _readAuthInternal.isDenied(WALLETS[w])) failures.push(`${label}: refusal recorded for a wallet that is not connected`)
        }
        // [A100 R2-1] Any fills read verifies the entry before sending it: a planted one is gone, the owner connected or not
        // (the check below then holds every entry under W to "recovers to W").
        planted.delete(w)
      } else if (op < 0.9) {
        // What 302f9cec could leave behind: another account's signature cached under W.
        const issuedAt = Math.floor(Date.now() / 1000)
        const by = (w + 1 + Math.floor(rand() * 2)) % 3
        storeOrdersReadAuth(WALLETS[w], { issuedAt, signature: await KEYS[by].signTypedData(buildOrdersReadTypedData(WALLETS[w], issuedAt)) })
        planted.add(w)
      } else {
        retryOrdersReadAuth(WALLETS[w])
      }

      for (let k = 0; k < 3; k++) {
        const entry = getCachedOrdersReadAuth(WALLETS[k])
        if (entry && !planted.has(k) && !(await recoversTo(WALLETS[k], entry))) failures.push(`${label}: entry under wallet #${k} does not recover to it`)
      }
    }

    expect(failures).toEqual([])
    expect(foreignSent).toEqual([]) // [A100 R2-1] no request ever carried a signature that was not its wallet's own
    expect(seen.plantedReadNotConnected).toBeGreaterThan(0)
    expect(seen.storedOwn).toBeGreaterThan(0)
    expect(seen.refusedForeign).toBeGreaterThan(0)
    expect(seen.mismatchNotReasked).toBeGreaterThan(0) // [A100 R2-3]
    expect(seen.droppedPlanted).toBeGreaterThan(0)
    expect(seen.refusalsRecorded).toBeGreaterThan(0)
    expect(seen.notConnected).toBeGreaterThan(0)
  })
})
