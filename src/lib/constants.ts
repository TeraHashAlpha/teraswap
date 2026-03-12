// ── API & Chain ──────────────────────────────────────────
export const CHAIN_ID = 1 // Ethereum mainnet

// ── Aggregator APIs ──────────────────────────────────────
export const AGGREGATOR_APIS = {
  '1inch': {
    base: 'https://api.1inch.dev/swap/v6.0/1',
    // [Audit] API keys moved to server-only env vars (no NEXT_PUBLIC_ prefix)
    // Falls back to NEXT_PUBLIC_ for backward compatibility during migration
    get key() { return process.env.ONEINCH_API_KEY || process.env.NEXT_PUBLIC_1INCH_API_KEY || '' },
  },
  '0x': {
    base: 'https://api.0x.org',
    get key() { return process.env.ZEROX_API_KEY || process.env.NEXT_PUBLIC_0X_API_KEY || '' },
  },
  velora: {
    base: 'https://api.paraswap.io',
    key: '',
  },
  odos: {
    base: 'https://api.odos.xyz',
    key: '',
  },
  kyberswap: {
    base: 'https://aggregator-api.kyberswap.com/ethereum',
    key: '',
  },
  cowswap: {
    base: 'https://api.cow.fi/mainnet/api/v1',
    key: '',
  },
  uniswap: {
    base: '', // on-chain — no API base
    key: '',
  },
  uniswapv3: {
    base: '', // on-chain direct — same contracts, separate source label for fee-tier detection
    key: '',
  },
  openocean: {
    base: 'https://open-api.openocean.finance/v4/1',
    key: '',
  },
  sushiswap: {
    base: 'https://api.sushi.com/swap/v7/1',
    key: '',
  },
  balancer: {
    base: 'https://api-v3.balancer.fi',
    key: '',
  },
  curve: {
    base: '', // on-chain — uses RateProvider + CurveRouterNG contracts
    key: '',
  },
  teraswap_order_engine: {
    base: '', // autonomous — self-hosted executor + Chainlink execution
    key: '',
  },
} as const

export type AggregatorName = keyof typeof AGGREGATOR_APIS

// ── CoW Protocol chain-aware API URLs ─────────────────────
// The static AGGREGATOR_APIS.cowswap.base is mainnet-only.
// Use getCowApiBase(chainId) for multi-chain support.
// [H-01] Sepolia removed for mainnet deployment.
const COW_API_URLS: Record<number, string> = {
  1: 'https://api.cow.fi/mainnet/api/v1',
  100: 'https://api.cow.fi/xdai/api/v1',
}
export function getCowApiBase(chainId: number): string {
  return COW_API_URLS[chainId] || COW_API_URLS[1]
}

// ── Aggregator metadata (for UI) ─────────────────────────
export const AGGREGATOR_META: Record<AggregatorName, {
  label: string
  mevProtected: boolean
  intentBased: boolean
  isDirect: boolean
  /** Estimated extra execution time in seconds (vs instant tx) */
  estimatedTime?: number
}> = {
  '1inch': { label: '1inch', mevProtected: false, intentBased: false, isDirect: false },
  '0x': { label: '0x/Matcha', mevProtected: false, intentBased: false, isDirect: false },
  velora: { label: 'Velora', mevProtected: false, intentBased: false, isDirect: false },
  odos: { label: 'Odos', mevProtected: false, intentBased: false, isDirect: false },
  kyberswap: { label: 'KyberSwap', mevProtected: false, intentBased: false, isDirect: false },
  cowswap: { label: 'CoW Protocol', mevProtected: true, intentBased: true, isDirect: false, estimatedTime: 30 },
  uniswap: { label: 'Uniswap V3', mevProtected: false, intentBased: false, isDirect: true },
  uniswapv3: { label: 'Uniswap V3', mevProtected: false, intentBased: false, isDirect: true },
  openocean: { label: 'OpenOcean', mevProtected: false, intentBased: false, isDirect: false },
  sushiswap: { label: 'SushiSwap', mevProtected: false, intentBased: false, isDirect: false },
  balancer: { label: 'Balancer', mevProtected: false, intentBased: false, isDirect: false },
  curve: { label: 'Curve Finance', mevProtected: false, intentBased: false, isDirect: true },
  teraswap_order_engine: { label: 'TeraSwap Order Engine', mevProtected: true, intentBased: false, isDirect: false },
}

// ── Fee ──────────────────────────────────────────────────
export const FEE_PERCENT = Number(process.env.NEXT_PUBLIC_FEE_PERCENT ?? '0.1')
export const FEE_BPS = Math.round(FEE_PERCENT * 100) // 0.1% → 10 bps

// [C-07] SECURITY: Never default to zero address — fees would be permanently burned.
// These MUST be set in env vars. The validation layer (env-validation.ts) will
// catch missing values at startup.
const _feeRecipient = process.env.NEXT_PUBLIC_FEE_RECIPIENT ?? ''
if (_feeRecipient && _feeRecipient === '0x0000000000000000000000000000000000000000') {
  console.error('[TeraSwap] CRITICAL: FEE_RECIPIENT is zero address — fees will be burned!')
}
export const FEE_RECIPIENT = (_feeRecipient || '0x107F6eB7C3866c9cEf5860952066e185e9383ABA') as `0x${string}`

// [C-08] FeeCollector proxy — deploy contracts/TeraSwapFeeCollector.sol and set this env var.
// Hard default to deployed mainnet FeeCollector so fees are never silently disabled.
const _feeCollector = process.env.NEXT_PUBLIC_FEE_COLLECTOR ?? ''
export const FEE_COLLECTOR_ADDRESS = (_feeCollector || '0x4dAEAf24Cd300a3DBc0caff3292B7840CDDa58eD') as `0x${string}`

// Sources that collect fees natively via their API (no FeeCollector needed)
// EMPTY: API fee params require registered partner accounts to work.
// All fee collection now goes through the FeeCollector smart contract.
export const FEE_NATIVE_SOURCES: AggregatorName[] = []

// Sources incompatible with FeeCollector proxy routing:
// - 0x: Uses Permit2 pull model (not standard ERC-20 approve)
// - cowswap: Intent-based (EIP-712 signing, no on-chain tx to intercept)
// These sources are excluded from quotes when FeeCollector is active
// to guarantee fee collection on every swap.
export const FEE_INCOMPATIBLE_SOURCES: AggregatorName[] = ['0x', 'cowswap']

// FeeCollector ABI (only the functions we call from the frontend)
export const FEE_COLLECTOR_ABI = [
  {
    name: 'swapETHWithFee',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'router', type: 'address' },
      { name: 'routerData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'swapTokenWithFee',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'totalAmount', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'routerData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

// ── Swap defaults ────────────────────────────────────────
export const DEFAULT_SLIPPAGE = 0.5
export const QUOTE_REFRESH_MS = 15_000
export const INPUT_DEBOUNCE_MS = 500
export const QUOTE_TIMEOUT_MS = 10_000

// ── Contracts ────────────────────────────────────────────
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

// CoW Protocol contracts
export const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110' as const
export const COW_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const

// Odos Router V3 (same address on all EVM chains)
export const ODOS_ROUTER_V3 = '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559' as const

// Uniswap V3 contracts (Ethereum mainnet)
export const UNISWAP_SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as const
export const UNISWAP_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const

// Uniswap V3 fee tiers (in hundredths of a bip)
export const UNISWAP_FEE_TIERS = [100, 500, 3000, 10000] as const // 0.01%, 0.05%, 0.3%, 1%

export const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const

export const CHAINLINK_FEEDS: Record<string, `0x${string}`> = {
  // ── Stablecoins ──
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', // USDC/USD
  '0xdac17f958d2ee523a2206206994597c13d831ec7': '0x3E7d1eAB13ad0104d2750B8863b489D65364e32D', // USDT/USD
  '0x6b175474e89094c44da98b954eedeac495271d0f': '0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9', // DAI/USD
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': '0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961', // USDe/USD
  // ── Blue chips ──
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', // WBTC/USD
  '0x514910771af9ca656af840dff83e8264ecf986ca': '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c', // LINK/USD
  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': '0x553303d460EE0afB37EdFf9bE42922D8FF63220e', // UNI/USD
  '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9', // AAVE/USD
  '0xc00e94cb662c3520282e6f5717214004a7f26888': '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5', // COMP/USD
  '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': '0xec1D1B3b0443256cc3860e24a46F108e699484Aa', // MKR/USD
  '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': '0xDC3EA94CD0AC27d9A86C180091e7f78C683d3699', // SNX/USD
  // ── DeFi governance ──
  '0xd533a949740bb3306d119cc777fa900ba034cd52': '0xCd627aA160A6fA45Eb793D19Ef54f5062F20f33f', // CRV/USD
  '0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e': '0xA027702dbb89fbd58938e4324ac03B58d812b0E1', // YFI/USD
  '0xba100000625a3754423978a60c9317c58a424e3d': '0xdF2917806E30300537aEB49A7663062F4d1F2b5F', // BAL/USD
  '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2': '0xCc70F09A6CC17553b2E31954cD36E4A2d89501f7', // SUSHI/USD
  // ── LSDs & others ──
  '0x5a98fcbea516cf06857215779fd812ca3bef1b32': '0x4e844125952D32AcdF339BE976c98E22F6F318dB', // LDO/USD
  '0x4d224452801aced8b2f0aebe155379bb5d594381': '0xD10aBbC76679a20055E167BB80A24ac851b37571', // APE/USD
  '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676', // MATIC/USD
  '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': '0x5C00128d4d1c2F4f652C267d7bcdD7aC99C16E16', // ENS/USD
  '0x111111111117dc0aa78b770fa6a738034120c302': '0xc929ad75B72593967DE83E7F7Cda0493458261D9', // 1INCH/USD
  '0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0': '0x6Ebc52C8C1089be9eB3945C4350B68B8E4C2233f', // FXS/USD
  '0xd33526068d116ce69f19a9ee46f0bd304f21a51f': '0x4E155eD98aFE9034b7A5962f6C84c86d869daA9d', // RPL/USD
  // ── Meme / popular ──
  '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': '0x8dD1CD88F43aF196ae478e91b9F5E4Ac69A97C61', // SHIB/USD
  '0x6982508145454ce325ddbe47a25d4ec3d2311933': '0x02DE28aB3C28A5B1E8236B1069a211b7494F0f35', // PEPE/USD
}

// ── Native ETH ───────────────────────────────────────────
export const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const
export const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const

// ── Etherscan ────────────────────────────────────────────
export const ETHERSCAN_TX = 'https://etherscan.io/tx/'
export const ETHERSCAN_TOKEN = 'https://etherscan.io/token/'
export const ETHERSCAN_ADDRESS = 'https://etherscan.io/address/'

// ── Price deviation (Chainlink) ─────────────────────────
// [L-02] Tightened for mainnet safety: block at 3% (was 5%).
// A 5% deviation on mainnet blue-chips is almost certainly a
// stale oracle or price manipulation attack. 3% covers normal
// volatility while catching anomalies earlier.
export const PRICE_DEVIATION_WARN = 0.02  // 2%
export const PRICE_DEVIATION_BLOCK = 0.03 // 3% — tightened from 5%

// ── Oracle Unavailable Protection ───────────────────────
// When no Chainlink feed exists for a token, we can't independently verify the
// swap price. Large swaps on unverified tokens are extremely dangerous (see: $50M
// aEthUSDT→aEthAAVE incident via CoW Protocol, where aggregators couldn't price
// wrapped Aave tokens). These thresholds add friction for unverified swaps.
/** USD value above which unverified swaps show a strong warning */
export const UNVERIFIED_SWAP_WARN_USD = 1_000
/** USD value above which unverified swaps are hard-blocked */
export const UNVERIFIED_SWAP_BLOCK_USD = 10_000

// ── Permit2 Security ────────────────────────────────────
/** Maximum signature deadline for Permit2 signatures (30 minutes) */
export const PERMIT2_MAX_DEADLINE_SEC = 30 * 60 // 1800 seconds
/** Maximum expiration for Permit2 allowances (24 hours) */
export const PERMIT2_MAX_EXPIRATION_SEC = 24 * 60 * 60 // 86400 seconds

// ── CoW Protocol Order Limits ───────────────────────────
// [L-04] Separate constant for CoW order duration — CoW solvers need more time
// than Permit2 signatures. 30 min matches the typical solver auction window.
/** Maximum CoW Protocol order validity (30 minutes) */
export const COW_MAX_ORDER_DURATION_SEC = 30 * 60 // 1800 seconds

// ── Chainlink Staleness ─────────────────────────────────
/** Max age for Chainlink data before considered stale (1 hour) */
export const CHAINLINK_MAX_STALENESS_SEC = 3600
