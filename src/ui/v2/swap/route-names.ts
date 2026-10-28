/**
 * [ADR-025] The venues a Route row may NAME. An aggregator reports a hop as whatever string its own API uses: KyberSwap's
 * `exchange` is an internal id ("fermi", "metric-v1", "pmm-1/uniswapv3", "hashflow-v3/uniswapv3"), sometimes a pool address or a
 * hash; Velora's is a venue id too. v1 prints those as the Route (the owner's B3 review saw `fermi`, `metric-v1` and hex strings).
 * v2 shows a hop only if it is a venue we can name — everything else is the SOURCE's own name ("KyberSwap"), so the row is always
 * a name a user can read and never an internal id.
 *
 * Keys are matched case-insensitively with every non-alphanumeric stripped (`uniswap-v3` = `UniswapV3` = `Uniswap V3`), so both the
 * raw ids an adapter forwards and the display names `veloraHopLabel` already produces pass. The list is Velora's own table
 * (src/lib/adapters/velora.ts, [chore/copy-leftovers]) plus Dexalot (the pack's frame-20 route). It is an allow-list: adding a venue
 * is a one-line, reviewed change; an unknown one is never guessed at.
 */
const KNOWN_DEX: ReadonlyMap<string, string> = new Map([
  ['uniswapv2', 'Uniswap V2'],
  ['uniswapv3', 'Uniswap V3'],
  ['uniswapv4', 'Uniswap V4'],
  ['sushiswap', 'SushiSwap'],
  ['sushiswapv3', 'SushiSwap V3'],
  ['pancakeswapv2', 'PancakeSwap V2'],
  ['pancakeswapv3', 'PancakeSwap V3'],
  ['curve', 'Curve'],
  ['curvev1', 'Curve'],
  ['curvev2', 'Curve'],
  ['balancerv1', 'Balancer'],
  ['balancerv2', 'Balancer'],
  ['balancerv3', 'Balancer'],
  ['aerodrome', 'Aerodrome'],
  ['aerodromeslipstream', 'Aerodrome Slipstream'],
  ['camelotv3', 'Camelot V3'],
  ['dexalot', 'Dexalot'],
])

/** The display name of a known venue, or null when `hop` is not one (an internal id, a pool address, a hash, free text). */
export function knownDexName(hop: string): string | null {
  return KNOWN_DEX.get(hop.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? null
}
