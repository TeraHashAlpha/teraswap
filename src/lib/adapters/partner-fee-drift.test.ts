// @vitest-environment node
/**
 * [fix/zerox-partner-fee-armed] FEE_NATIVE_SOURCES drift guard.
 *
 * INVARIANT: a source is fee-native IF AND ONLY IF its adapter attaches
 * partner-fee params to an outgoing request.
 *
 * THE DRIFT THIS EXISTS TO PREVENT (measured 2026-09-03, not hypothetical):
 * SPRINT-9T T1 taught adapters/zerox.ts to send swapFeeRecipient + swapFeeBps on
 * BOTH the quote and the swap build, so 0x really was collecting TeraSwap's 0.1%
 * natively. FEE_NATIVE_SOURCES was left `[]`. Two live consequences:
 *   - useSwap.ts gates the M-01 fee-integrity check on that list, so the check
 *     NEVER ran for 0x. Had 0x silently ignored our fee params we would have
 *     displayed a fee, collected nothing, and had no signal.
 *   - QuoteBreakdown.tsx decided "fee collected" with
 *     `FEE_NATIVE_SOURCES.includes(source) || isFeeCollectorActive()`, so the 0x
 *     row's fee claim rested on the FeeCollector being active — a mechanism 0x
 *     never touches (it is FEE_INCOMPATIBLE). Right answer, wrong reason.
 *
 * Rather than assert a hardcoded list (which is the thing that drifted), this
 * test DRIVES every registered adapter with a recording `fetch` stub and reads
 * the params they actually put on the wire. Both directions are enforced:
 *   forward — an adapter that sends fee params must be IN FEE_NATIVE_SOURCES
 *   reverse — a source in FEE_NATIVE_SOURCES must actually send fee params
 *
 * LIMITATION (deliberate, see FEEDBACK): detection is a curated marker list of
 * vendor partner-fee param names. A future vendor inventing a name outside this
 * list would not be caught — adding an integration means adding its marker here.
 * The list is intentionally NOT "any param whose value is FEE_RECIPIENT": CoW
 * sends `metadata.referrer.address = FEE_RECIPIENT` on the fee-FREE appData too,
 * and a referrer tag collects nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ADAPTER_REGISTRY } from './index'
import { FEE_NATIVE_SOURCES, type AggregatorName } from '@/lib/constants'

/** Vendor partner-fee param names. Substring-matched against URL + request body. */
const PARTNER_FEE_MARKERS = [
  'swapFeeBps', 'swapFeeRecipient',   // 0x v2 (swap/permit2 + swap/allowance-holder)
  'partnerFee',                        // CoW Protocol appData metadata.partnerFee
  'fee_recipient',                     // Bebop JAM (paired with `fee` bps)
  'buyTokenPercentageFee',             // 0x v1 / 1inch-style percentage fee
  'referrerAddress', 'referrerFee',    // Odos-style referral fee
  'feeRecipient', 'partnerAddress', 'partnerFeeBps', // generic vendor spellings
]

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const TAKER = '0x1111111111111111111111111111111111111111'

/** Drive one adapter and return the first partner-fee marker it puts on the wire. */
async function observeMarker(adapter: (typeof ADAPTER_REGISTRY)[number]): Promise<string | null> {
  const wire: string[] = []
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (...args: unknown[]) => {
    const [input, init] = args as [unknown, { body?: unknown } | undefined]
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    wire.push(`${url} ${init?.body ? String(init.body) : ''}`)
    // A JSON-RPC error body makes viem-backed adapters (uniswapv3, curve) throw
    // immediately instead of retrying, and makes HTTP adapters fail their field
    // parsing. Either way the REQUEST is already recorded, which is all we read.
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'stub' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  })

  const quoteParams = { src: WETH, dst: USDC, amount: '1000000000000000000', chainId: 1 }
  const swapParams = { ...quoteParams, from: TAKER, slippage: 0.5 }
  // Adapters are EXPECTED to throw/return null against the stub — we only care
  // about what they sent, never about what they parsed back.
  await adapter.fetchQuote(quoteParams).catch(() => null)
  await adapter.fetchSwapData(swapParams).catch(() => null)
  spy.mockRestore()

  const joined = wire.join('\n')
  return PARTNER_FEE_MARKERS.find((m) => joined.includes(m)) ?? null
}

/**
 * The invariant, as a pure function so the negative control can run the SAME
 * logic against a different list instead of re-implementing it.
 */
function driftViolations(
  observed: ReadonlyMap<AggregatorName, string | null>,
  list: readonly AggregatorName[],
): string[] {
  const out: string[] = []
  for (const [source, marker] of observed) {
    const listed = list.includes(source)
    if (marker && !listed) {
      out.push(`${source} sends '${marker}' but is MISSING from FEE_NATIVE_SOURCES`)
    }
    if (!marker && listed) {
      out.push(`${source} is in FEE_NATIVE_SOURCES but sends no partner-fee params`)
    }
  }
  return out.sort()
}

describe('[fix/zerox-partner-fee-armed] FEE_NATIVE_SOURCES matches what adapters actually send', () => {
  let observed: Map<AggregatorName, string | null>

  beforeEach(async () => {
    // Keys must look present or a keyed adapter self-suppresses before it ever
    // builds a request, which would read as "sends no fee params".
    for (const k of ['ONEINCH_API_KEY', 'ZEROX_API_KEY', 'ODOS_API_KEY', 'BEBOP_API_KEY', 'VELORA_API_KEY']) {
      process.env[k] = process.env[k] || 'test-key'
    }
    observed = new Map()
    for (const adapter of ADAPTER_REGISTRY) {
      observed.set(adapter.name, await observeMarker(adapter))
    }
  }, 60_000)

  afterEach(() => vi.restoreAllMocks())

  it('acceptance 1 — FEE_NATIVE_SOURCES contains 0x', () => {
    expect(FEE_NATIVE_SOURCES).toContain('0x')
  })

  it("0x really does put swapFeeBps on the wire (the fact the list must reflect)", () => {
    expect(observed.get('0x')).toBe('swapFeeBps')
  })

  it('every adapter that sends partner-fee params is listed, and vice versa', () => {
    expect(driftViolations(observed, FEE_NATIVE_SOURCES)).toEqual([])
  })

  it('the three fee-native sources are exactly the ones sending fee params', () => {
    const sending = [...observed].filter(([, m]) => m !== null).map(([s]) => s).sort()
    expect(sending).toEqual(['0x', 'bebop', 'cowswap'])
    expect([...FEE_NATIVE_SOURCES].sort()).toEqual(sending)
  })

  // ── Negative control ──────────────────────────────────────────────────
  // The same invariant run against origin/main's `FEE_NATIVE_SOURCES = []`.
  // If this passed, the guard would be vacuous and could not have caught the
  // drift it was written for.
  it("NEGATIVE CONTROL: the pre-fix empty list violates the invariant for 0x", () => {
    const violations = driftViolations(observed, [])
    expect(violations).toContain("0x sends 'swapFeeBps' but is MISSING from FEE_NATIVE_SOURCES")
    expect(violations).toHaveLength(3) // 0x, cowswap, bebop were all unlisted
  })

  it('NEGATIVE CONTROL: listing a source that sends no fee params also fails', () => {
    // kyberswap routes through the FeeCollector and sends no partner-fee params.
    expect(driftViolations(observed, ['kyberswap'])).toContain(
      'kyberswap is in FEE_NATIVE_SOURCES but sends no partner-fee params',
    )
  })
})
