/**
 * [fix/functional-chain-ui F4] Five consecutive days of confirmed mainnet swaps (20–24 Jun 2026,
 * `swaps` table row shape) for the /api/analytics transform. Deliberately adversarial:
 *
 *   - rows are listed OLDEST-first, while computeDashboard re-sorts events newest-first — the
 *     ordering that used to put today on the LEFT of the Volume Trend chart;
 *   - pair VOLUME ranks WBTC/USDC ($5000, 1 trade) > WETH/USDC ($3000, 2) > WETH/DAI ($170, 5),
 *     the exact reverse of TRADE COUNT — so a volume-ranked list printing trade counts looks unsorted.
 */
export const FIVE_DAY_NOW = '2026-06-24T18:00:00.000Z'

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' // gitleaks:allow — public WETH ERC-20 address, not a secret
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' // gitleaks:allow — public USDC ERC-20 address, not a secret
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f' // gitleaks:allow — public DAI ERC-20 address, not a secret
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' // gitleaks:allow — public WBTC ERC-20 address, not a secret

const TOKENS = { WETH, USDC, DAI, WBTC } as const
type Sym = keyof typeof TOKENS

let n = 0
function swap(createdAt: string, tokenIn: Sym, tokenOut: Sym, usd: number): Record<string, unknown> {
  n++
  return {
    id: `swap-${n}`,
    created_at: createdAt,
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    tx_hash: `0x${n.toString(16).padStart(64, '0')}`,
    chain_id: 1,
    status: 'confirmed',
    source: '1inch',
    token_in: TOKENS[tokenIn],
    token_in_symbol: tokenIn,
    token_out: TOKENS[tokenOut],
    token_out_symbol: tokenOut,
    amount_in: '1000000000000000000',
    amount_out: '1',
    amount_in_usd: usd,
    amount_out_usd: usd,
    fee_collected: true,
  }
}

export const FIVE_DAY_SWAPS: Record<string, unknown>[] = [
  swap('2026-06-20T09:00:00.000Z', 'WETH', 'USDC', 1000),
  swap('2026-06-21T09:00:00.000Z', 'WETH', 'DAI', 50),
  swap('2026-06-21T10:00:00.000Z', 'WETH', 'DAI', 50),
  swap('2026-06-21T11:00:00.000Z', 'WETH', 'DAI', 50),
  swap('2026-06-22T09:00:00.000Z', 'WETH', 'USDC', 2000),
  swap('2026-06-23T09:00:00.000Z', 'WBTC', 'USDC', 5000),
  swap('2026-06-24T09:00:00.000Z', 'WETH', 'DAI', 10),
  swap('2026-06-24T10:00:00.000Z', 'WETH', 'DAI', 10),
]
