import { NATIVE_ETH } from './constants'

export type TokenCategory =
  | 'Native'
  | 'Stablecoin'
  | 'Wrapped BTC'
  | 'Liquid Staking'
  | 'DeFi'
  | 'L2 & Infrastructure'
  | 'AI & Data'
  | 'Memecoin'
  | 'Gaming & Metaverse'
  | 'Other'
  | 'Imported'

export interface Token {
  address: `0x${string}`
  symbol: string
  name: string
  decimals: number
  logoURI: string
  category: TokenCategory
}

// ── Logo helper (1inch token icons, lowercase address) ───
function logo(addr: string): string {
  return `https://tokens.1inch.io/${addr.toLowerCase()}.png`
}

// ── Top 80+ tokens by Ethereum on-chain volume ──────────
// Source: Uniswap default token list + on-chain volume data
// Last updated: 4 Mar 2026
export const DEFAULT_TOKENS: Token[] = [
  // ─── Native + Wrapped ETH ───────────────────────────────
  {
    address: NATIVE_ETH,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    logoURI: logo('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
    category: 'Native',
  },
  {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    logoURI: logo('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
    category: 'Native',
  },

  // ─── Stablecoins ────────────────────────────────────────
  {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logoURI: logo('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
    category: 'Stablecoin',
  },
  {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    logoURI: logo('0xdac17f958d2ee523a2206206994597c13d831ec7'),
    category: 'Stablecoin',
  },
  {
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    logoURI: logo('0x6b175474e89094c44da98b954eedeac495271d0f'),
    category: 'Stablecoin',
  },
  {
    address: '0x853d955aCEf822Db058eb8505911ED77F175b99e',
    symbol: 'FRAX',
    name: 'Frax',
    decimals: 18,
    logoURI: logo('0x853d955acef822db058eb8505911ed77f175b99e'),
    category: 'Stablecoin',
  },
  {
    address: '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0',
    symbol: 'LUSD',
    name: 'Liquity USD',
    decimals: 18,
    logoURI: logo('0x5f98805a4e8be255a32880fdec7f6728c6568ba0'),
    category: 'Stablecoin',
  },
  {
    address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
    symbol: 'PYUSD',
    name: 'PayPal USD',
    decimals: 6,
    logoURI: logo('0x6c3ea9036406852006290770bedfcaba0e23a0e8'),
    category: 'Stablecoin',
  },
  {
    address: '0x4c9EDD5852cd905f23c3acF6C2ff8eca3ce50370',
    symbol: 'USDe',
    name: 'Ethena USDe',
    decimals: 18,
    logoURI: logo('0x4c9edd5852cd905f23c3acf6c2ff8eca3ce50370'),
    category: 'Stablecoin',
  },
  {
    address: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    symbol: 'USDS',
    name: 'USDS Stablecoin',
    decimals: 18,
    logoURI: logo('0xdc035d45d973e3ec169d2276ddab16f1e407384f'),
    category: 'Stablecoin',
  },
  {
    address: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
    symbol: 'GHO',
    name: 'Aave GHO',
    decimals: 18,
    logoURI: logo('0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'),
    category: 'Stablecoin',
  },
  {
    address: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E',
    symbol: 'crvUSD',
    name: 'Curve USD',
    decimals: 18,
    logoURI: logo('0xf939e0a03fb07f59a73314e73794be0e57ac1b4e'),
    category: 'Stablecoin',
  },
  {
    address: '0x6440f144b7e50D6a8439336510312d2F54beB01D',
    symbol: 'BOLD',
    name: 'Liquity BOLD',
    decimals: 18,
    logoURI: logo('0x6440f144b7e50d6a8439336510312d2f54beb01d'), // TODO: 1inch logo returns 403 — may need local fallback /public/tokens/bold.png
    category: 'Stablecoin',
  },

  // ─── BTC Wrapped ────────────────────────────────────────
  {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    decimals: 8,
    logoURI: logo('0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'),
    category: 'Wrapped BTC',
  },
  {
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    logoURI: logo('0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'),
    category: 'Wrapped BTC',
  },
  {
    address: '0x18084fbA666a33d37592fA2633fD49a74DD93a88',
    symbol: 'tBTC',
    name: 'tBTC v2',
    decimals: 18,
    logoURI: logo('0x18084fba666a33d37592fa2633fd49a74dd93a88'),
    category: 'Wrapped BTC',
  },

  // ─── Liquid Staking ─────────────────────────────────────
  {
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    symbol: 'wstETH',
    name: 'Wrapped stETH (Lido)',
    decimals: 18,
    logoURI: logo('0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0'),
    category: 'Liquid Staking',
  },
  {
    address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704',
    symbol: 'cbETH',
    name: 'Coinbase Wrapped Staked ETH',
    decimals: 18,
    logoURI: logo('0xbe9895146f7af43049ca1c1ae358b0541ea49704'),
    category: 'Liquid Staking',
  },
  {
    address: '0xCd5fE23C85820F7B72D6468176c4aF32e4ff4b25',
    symbol: 'weETH',
    name: 'Wrapped eETH (EtherFi)',
    decimals: 18,
    logoURI: logo('0xcd5fe23c85820f7b72d6468176c4af32e4ff4b25'),
    category: 'Liquid Staking',
  },
  {
    address: '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7',
    symbol: 'rsETH',
    name: 'KelpDAO Restaked ETH',
    decimals: 18,
    logoURI: logo('0xa1290d69c65a6fe4df752f95823fae25cb99e5a7'),
    category: 'Liquid Staking',
  },
  {
    address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    symbol: 'stETH',
    name: 'Lido Staked ETH',
    decimals: 18,
    logoURI: logo('0xae7ab96520de3a18e5e111b5eaab095312d7fe84'),
    category: 'Liquid Staking',
  },
  {
    address: '0xae78736Cd615f374D3085123A210448E74Fc6393',
    symbol: 'rETH',
    name: 'Rocket Pool ETH',
    decimals: 18,
    logoURI: logo('0xae78736cd615f374d3085123a210448e74fc6393'),
    category: 'Liquid Staking',
  },
  {
    address: '0xac3E018457B222d93114458476f3E3416Abbe38F',
    symbol: 'sfrxETH',
    name: 'Staked Frax Ether',
    decimals: 18,
    logoURI: logo('0xac3e018457b222d93114458476f3e3416abbe38f'),
    category: 'Liquid Staking',
  },
  {
    address: '0xbf5495Efe5DB9ce00f80364C8B423567e58d2110',
    symbol: 'ezETH',
    name: 'Renzo Restaked ETH',
    decimals: 18,
    logoURI: logo('0xbf5495efe5db9ce00f80364c8b423567e58d2110'),
    category: 'Liquid Staking',
  },
  {
    address: '0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa',
    symbol: 'mETH',
    name: 'Mantle Staked ETH',
    decimals: 18,
    logoURI: logo('0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa'),
    category: 'Liquid Staking',
  },
  {
    address: '0xA35b1B31Ce002FBF2058D22F30f95D405200A15b',
    symbol: 'ETHx',
    name: 'Stader ETHx',
    decimals: 18,
    logoURI: logo('0xa35b1b31ce002fbf2058d22f30f95d405200a15b'),
    category: 'Liquid Staking',
  },
  {
    address: '0xf951E335afb289353dc249e82926178EaC7DEd78',
    symbol: 'swETH',
    name: 'Swell ETH',
    decimals: 18,
    logoURI: logo('0xf951e335afb289353dc249e82926178eac7ded78'),
    category: 'Liquid Staking',
  },

  // ─── DeFi Blue Chips ────────────────────────────────────
  {
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    logoURI: logo('0x514910771af9ca656af840dff83e8264ecf986ca'),
    category: 'DeFi',
  },
  {
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    logoURI: logo('0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'),
    category: 'DeFi',
  },
  {
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    symbol: 'AAVE',
    name: 'Aave',
    decimals: 18,
    logoURI: logo('0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'),
    category: 'DeFi',
  },
  {
    address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2',
    symbol: 'MKR',
    name: 'Maker',
    decimals: 18,
    logoURI: logo('0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2'),
    category: 'DeFi',
  },
  {
    address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32',
    symbol: 'LDO',
    name: 'Lido DAO',
    decimals: 18,
    logoURI: logo('0x5a98fcbea516cf06857215779fd812ca3bef1b32'),
    category: 'DeFi',
  },
  {
    address: '0xD533a949740bb3306d119CC777fa900bA034cd52',
    symbol: 'CRV',
    name: 'Curve DAO Token',
    decimals: 18,
    logoURI: logo('0xd533a949740bb3306d119cc777fa900ba034cd52'),
    category: 'DeFi',
  },
  {
    address: '0xc00e94Cb662C3520282E6f5717214004A7f26888',
    symbol: 'COMP',
    name: 'Compound',
    decimals: 18,
    logoURI: logo('0xc00e94cb662c3520282e6f5717214004a7f26888'),
    category: 'DeFi',
  },
  {
    address: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F',
    symbol: 'SNX',
    name: 'Synthetix',
    decimals: 18,
    logoURI: logo('0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f'),
    category: 'DeFi',
  },
  {
    address: '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2',
    symbol: 'SUSHI',
    name: 'SushiSwap',
    decimals: 18,
    logoURI: logo('0x6b3595068778dd592e39a122f4f5a5cf09c90fe2'),
    category: 'DeFi',
  },
  {
    address: '0xba100000625a3754423978a60c9317c58a424e3D',
    symbol: 'BAL',
    name: 'Balancer',
    decimals: 18,
    logoURI: logo('0xba100000625a3754423978a60c9317c58a424e3d'),
    category: 'DeFi',
  },
  {
    address: '0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B',
    symbol: 'CVX',
    name: 'Convex Finance',
    decimals: 18,
    logoURI: logo('0x4e3fbd56cd56c3e72c1403e103b45db9da5b9d2b'),
    category: 'DeFi',
  },
  {
    address: '0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0',
    symbol: 'FXS',
    name: 'Frax Share',
    decimals: 18,
    logoURI: logo('0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0'),
    category: 'DeFi',
  },
  {
    address: '0xDEf1CA1fb7FBcDC777520aa7f396b4E015F497aB',
    symbol: 'COW',
    name: 'CoW Protocol',
    decimals: 18,
    logoURI: logo('0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab'),
    category: 'DeFi',
  },
  {
    address: '0x57e114B691Db790C35207b2e685D4A43181e6061',
    symbol: 'ENA',
    name: 'Ethena',
    decimals: 18,
    logoURI: logo('0x57e114b691db790c35207b2e685d4a43181e6061'),
    category: 'DeFi',
  },
  {
    address: '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB',
    symbol: 'ETHFI',
    name: 'Ether.fi',
    decimals: 18,
    logoURI: logo('0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb'),
    category: 'DeFi',
  },
  {
    address: '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3',
    symbol: 'ONDO',
    name: 'Ondo Finance',
    decimals: 18,
    logoURI: logo('0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3'),
    category: 'DeFi',
  },
  {
    address: '0x808507121B80c02388fAd14726482e061B8da827',
    symbol: 'PENDLE',
    name: 'Pendle',
    decimals: 18,
    logoURI: logo('0x808507121b80c02388fad14726482e061b8da827'),
    category: 'DeFi',
  },
  {
    address: '0xD33526068D116cE69F19A9ee46F0bd304F21A51f',
    symbol: 'RPL',
    name: 'Rocket Pool',
    decimals: 18,
    logoURI: logo('0xd33526068d116ce69f19a9ee46f0bd304f21a51f'),
    category: 'DeFi',
  },
  {
    address: '0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e',
    symbol: 'YFI',
    name: 'yearn.finance',
    decimals: 18,
    logoURI: logo('0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e'),
    category: 'DeFi',
  },
  {
    address: '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83',
    symbol: 'EIGEN',
    name: 'EigenLayer',
    decimals: 18,
    logoURI: logo('0xec53bf9167f50cdeb3ae105f56099aaab9061f83'),
    category: 'DeFi',
  },
  {
    address: '0x9994E35Db50125E0DF82e4c2dde62496CE330999',
    symbol: 'MORPHO',
    name: 'Morpho',
    decimals: 18,
    logoURI: logo('0x9994e35db50125e0df82e4c2dde62496ce330999'),
    category: 'DeFi',
  },
  {
    address: '0x9D65fF81a3c488d585bBfb0Bfe3c7707c7917f54',
    symbol: 'SSV',
    name: 'SSV Network',
    decimals: 18,
    logoURI: logo('0x9d65ff81a3c488d585bbfb0bfe3c7707c7917f54'),
    category: 'DeFi',
  },

  // ─── L2 / Infrastructure ────────────────────────────────
  {
    address: '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1',
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
    logoURI: logo('0xb50721bcf8d664c30412cfbc6cf7a15145234ad1'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6',
    symbol: 'POL',
    name: 'Polygon Ecosystem Token',
    decimals: 18,
    logoURI: logo('0x455e53cbb86018ac2b8092fdcd39d8444affc3f6'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0xCa14007Eff0dB1F8135f4C25B34De49AB0d42766',
    symbol: 'STRK',
    name: 'Starknet',
    decimals: 18,
    logoURI: logo('0xca14007eff0db1f8135f4c25b34de49ab0d42766'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0xc944E90C64B2c07662A292be6244BDf05Cda44a7',
    symbol: 'GRT',
    name: 'The Graph',
    decimals: 18,
    logoURI: logo('0xc944e90c64b2c07662a292be6244bdf05cda44a7'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72',
    symbol: 'ENS',
    name: 'Ethereum Name Service',
    decimals: 18,
    logoURI: logo('0xc18360217d8f7ab5e7c516566761ea12ce7f9d72'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0x6985884C4392D348587B19cb9eAAf157F13271cd',
    symbol: 'ZRO',
    name: 'LayerZero',
    decimals: 18,
    logoURI: logo('0x6985884c4392d348587b19cb9eaaf157f13271cd'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0x5aFE3855358E112B5647B952709E6165e1c1eEEe',
    symbol: 'SAFE',
    name: 'Safe',
    decimals: 18,
    logoURI: logo('0x5afe3855358e112b5647b952709e6165e1c1eeee'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0xB0fFa8000886e57F86dd5264b987b9993715e059',
    symbol: 'W',
    name: 'Wormhole',
    decimals: 18,
    logoURI: logo('0xb0ffa8000886e57f86dd5264b987b9993715e059'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0x8457CA5040ad67fdebbCC8EdCE889A335Bc0fbFB',
    symbol: 'ALT',
    name: 'AltLayer',
    decimals: 18,
    logoURI: logo('0x8457ca5040ad67fdebbc8edce889a335bc0fbfb'),
    category: 'L2 & Infrastructure',
  },

  // ─── AI / Data / Compute ────────────────────────────────
  {
    address: '0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24',
    symbol: 'RNDR',
    name: 'Render Token',
    decimals: 18,
    logoURI: logo('0x6de037ef9ad2725eb40118bb1702ebb27e4aeb24'),
    category: 'AI & Data',
  },
  {
    address: '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85',
    symbol: 'FET',
    name: 'Fetch.ai',
    decimals: 18,
    logoURI: logo('0xaea46a60368a7bd060eec7df8cba43b7ef41ad85'),
    category: 'AI & Data',
  },
  {
    address: '0x6E2a43be0B1d33b726f0CA3b8de60b3482b8b050',
    symbol: 'ARKM',
    name: 'Arkham',
    decimals: 18,
    logoURI: logo('0x6e2a43be0b1d33b726f0ca3b8de60b3482b8b050'),
    category: 'AI & Data',
  },
  {
    address: '0x163f8C2467924be0ae7B5347228CABF260318753',
    symbol: 'WLD',
    name: 'Worldcoin',
    decimals: 18,
    logoURI: logo('0x163f8c2467924be0ae7b5347228cabf260318753'),
    category: 'AI & Data',
  },

  // ─── Memecoins (high volume) ────────────────────────────
  {
    address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    symbol: 'PEPE',
    name: 'Pepe',
    decimals: 18,
    logoURI: logo('0x6982508145454ce325ddbe47a25d4ec3d2311933'),
    category: 'Memecoin',
  },
  {
    address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    symbol: 'SHIB',
    name: 'Shiba Inu',
    decimals: 18,
    logoURI: logo('0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce'),
    category: 'Memecoin',
  },
  {
    address: '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E',
    symbol: 'FLOKI',
    name: 'FLOKI',
    decimals: 9,
    logoURI: logo('0xcf0c122c6b73ff809c693db761e7baebe62b6a2e'),
    category: 'Memecoin',
  },
  {
    address: '0xA35923162C49cF95e6BF26623385eb431ad920D3',
    symbol: 'TURBO',
    name: 'Turbo',
    decimals: 18,
    logoURI: logo('0xa35923162c49cf95e6bf26623385eb431ad920d3'),
    category: 'Memecoin',
  },
  {
    address: '0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a',
    symbol: 'MOG',
    name: 'Mog Coin',
    decimals: 18,
    logoURI: logo('0xaaee1a9723aadb7afa2810263653a34ba2c21c7a'),
    category: 'Memecoin',
  },
  {
    address: '0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C',
    symbol: 'SPX',
    name: 'SPX6900',
    decimals: 8,
    logoURI: logo('0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c'),
    category: 'Memecoin',
  },
  {
    address: '0x9813037ee2218799597d83D4a5B6F3b6778218d9',
    symbol: 'BONE',
    name: 'Bone ShibaSwap',
    decimals: 18,
    logoURI: logo('0x9813037ee2218799597d83d4a5b6f3b6778218d9'),
    category: 'Memecoin',
  },

  // ─── Gaming / Metaverse ─────────────────────────────────
  {
    address: '0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b',
    symbol: 'AXS',
    name: 'Axie Infinity',
    decimals: 18,
    logoURI: logo('0xbb0e17ef65f82ab018d8edd776e8dd940327b28b'),
    category: 'Gaming & Metaverse',
  },
  {
    address: '0xb23d80f5FefcDDaa212212F028021B41DEd428CF',
    symbol: 'PRIME',
    name: 'Prime (Echelon)',
    decimals: 18,
    logoURI: logo('0xb23d80f5fefcddaa212212f028021b41ded428cf'),
    category: 'Gaming & Metaverse',
  },
  {
    address: '0xF57e7e7C23978C3cAEC3C3548E3D615c346e79fF',
    symbol: 'IMX',
    name: 'Immutable X',
    decimals: 18,
    logoURI: logo('0xf57e7e7c23978c3caec3c3548e3d615c346e79ff'),
    category: 'Gaming & Metaverse',
  },
  {
    address: '0x5283D291DBCF85356A21bA090E6db59121208b44',
    symbol: 'BLUR',
    name: 'Blur',
    decimals: 18,
    logoURI: logo('0x5283d291dbcf85356a21ba090e6db59121208b44'),
    category: 'Gaming & Metaverse',
  },
  {
    address: '0x4d224452801ACEd8B2F0aebE155379bb5D594381',
    symbol: 'APE',
    name: 'ApeCoin',
    decimals: 18,
    logoURI: logo('0x4d224452801aced8b2f0aebe155379bb5d594381'),
    category: 'Gaming & Metaverse',
  },
  {
    address: '0x3845badAde8e6dFF049820680d1F14bD3903a5d0',
    symbol: 'SAND',
    name: 'The Sandbox',
    decimals: 18,
    logoURI: logo('0x3845badade8e6dff049820680d1f14bd3903a5d0'),
    category: 'Gaming & Metaverse',
  },
  {
    address: '0x0F5D2fB29fb7d3CFeE444a200298f468908cC942',
    symbol: 'MANA',
    name: 'Decentraland',
    decimals: 18,
    logoURI: logo('0x0f5d2fb29fb7d3cfee444a200298f468908cc942'),
    category: 'Gaming & Metaverse',
  },

  // ─── Other High Volume ──────────────────────────────────
  {
    address: '0x111111111117dC0aa78b770fA6A738034120C302',
    symbol: '1INCH',
    name: '1inch',
    decimals: 18,
    logoURI: logo('0x111111111117dc0aa78b770fa6a738034120c302'),
    category: 'DeFi',
  },
  {
    address: '0x6810e776880C02933D47DB1b9fc05908e5386b96',
    symbol: 'GNO',
    name: 'Gnosis',
    decimals: 18,
    logoURI: logo('0x6810e776880c02933d47db1b9fc05908e5386b96'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0x92D6C1e31e14520e676a687F0a93788B716BEff5',
    symbol: 'DYDX',
    name: 'dYdX',
    decimals: 18,
    logoURI: logo('0x92d6c1e31e14520e676a687f0a93788b716beff5'),
    category: 'DeFi',
  },
  {
    address: '0x45804880De22913dAFE09f4980848ECE6EcbAf78',
    symbol: 'PAXG',
    name: 'PAX Gold',
    decimals: 18,
    logoURI: logo('0x45804880de22913dafe09f4980848ece6ecbaf78'),
    category: 'Other',
  },
  {
    address: '0x6DEA81C8171D0bA574754EF6F8b412F2Ed88c54D',
    symbol: 'LQTY',
    name: 'Liquity',
    decimals: 18,
    logoURI: logo('0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d'),
    category: 'DeFi',
  },
  {
    address: '0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD',
    symbol: 'LRC',
    name: 'Loopring',
    decimals: 18,
    logoURI: logo('0xbbbbca6a901c926f240b89eacb641d8aec7aeafd'),
    category: 'L2 & Infrastructure',
  },
  {
    address: '0x69af81e73A73B40adF4f3d4223Cd9b1ECE623074',
    symbol: 'MASK',
    name: 'Mask Network',
    decimals: 18,
    logoURI: logo('0x69af81e73a73b40adf4f3d4223cd9b1ece623074'),
    category: 'Other',
  },
  {
    address: '0x090185f2135308BaD17527004364eBcC2D37e5F6',
    symbol: 'SPELL',
    name: 'Spell Token',
    decimals: 18,
    logoURI: logo('0x090185f2135308bad17527004364ebcc2d37e5f6'),
    category: 'DeFi',
  },
]

// ── Custom token import cache (session-only) ─────────────
let customTokens: Token[] = []

export function getAllTokens(): Token[] {
  return [...DEFAULT_TOKENS, ...customTokens]
}

export function addCustomToken(token: Token): void {
  if (!customTokens.find(t => t.address.toLowerCase() === token.address.toLowerCase())) {
    customTokens.push({ ...token, category: token.category || 'Imported' })
  }
}

export function getCustomTokens(): Token[] {
  return customTokens
}

// Helper: find token by symbol
export function findToken(symbol: string): Token | undefined {
  return getAllTokens().find((t) => t.symbol.toLowerCase() === symbol.toLowerCase())
}

// Helper: find token by address
export function findTokenByAddress(address: string): Token | undefined {
  return getAllTokens().find((t) => t.address.toLowerCase() === address.toLowerCase())
}

// Helper: is native ETH
export function isNativeETH(token: Token): boolean {
  return token.address.toLowerCase() === NATIVE_ETH.toLowerCase()
}

// ── Category display order for TokenSelector grouping ───
export const CATEGORY_DISPLAY_ORDER: TokenCategory[] = [
  'Native', 'Stablecoin', 'Wrapped BTC', 'Liquid Staking', 'DeFi',
  'L2 & Infrastructure', 'AI & Data', 'Gaming & Metaverse', 'Memecoin',
  'Imported', 'Other',
]
