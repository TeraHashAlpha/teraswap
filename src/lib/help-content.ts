export interface HelpItem {
  q: string
  a: string
}

export interface HelpSection {
  title: string
  items: HelpItem[]
}

export const helpSections: HelpSection[] = [
  {
    title: 'Getting Started',
    items: [
      {
        q: 'What is TeraSwap?',
        a: 'TeraSwap is a DEX meta-aggregator that searches 11 liquidity sources simultaneously to find you the best swap rate on Ethereum. Instead of checking each DEX manually, TeraSwap does it in one click.',
      },
      {
        q: 'How do I connect my wallet?',
        a: 'Click "Connect Wallet" in the top-right corner. We support MetaMask, WalletConnect, Coinbase Wallet, and other popular wallets. Your funds always stay in your wallet — TeraSwap never takes custody.',
      },
      {
        q: 'Is TeraSwap free to use?',
        a: 'TeraSwap charges a 0.1% platform fee on swaps, deducted from the input amount before execution. You also pay the standard Ethereum network gas fee. CoW Protocol swaps are gasless for users. The fee is fully transparent and shown before you confirm.',
      },
      {
        q: 'Which networks are supported?',
        a: 'TeraSwap currently supports Ethereum Mainnet. More networks are on the roadmap.',
      },
    ],
  },
  {
    title: 'Swaps',
    items: [
      {
        q: 'How does the meta-aggregator work?',
        a: 'When you request a quote, TeraSwap queries 11 sources (1inch, 0x, Odos, KyberSwap, CowSwap, Uniswap V3, OpenOcean, SushiSwap, Balancer, Curve, and Velora) in parallel and ranks them by output amount. You always get the best available rate.',
      },
      {
        q: 'What is Split Routing?',
        a: 'For large trades, splitting across multiple DEXs can get you a better overall rate than sending everything through one source. TeraSwap automatically detects when splitting is beneficial.',
      },
      {
        q: 'What is slippage tolerance?',
        a: 'Slippage is the difference between the quoted price and the execution price. Setting a slippage tolerance (e.g. 0.5%) means your transaction will revert if the price moves more than that amount. Lower = safer but more likely to fail; higher = more likely to succeed but may get a worse price.',
      },
      {
        q: 'What is Price Impact?',
        a: "Price impact shows how much your trade moves the market price. A high price impact (>3%) means you're trading a large amount relative to the pool's liquidity. Consider splitting into smaller trades.",
      },
      {
        q: 'What is Permit2?',
        a: 'Permit2 is a token approval system by Uniswap that lets you approve tokens with a signature instead of an on-chain transaction. This saves gas and improves security by allowing time-limited approvals.',
      },
      {
        q: 'Why did my swap fail?',
        a: 'Common causes: slippage tolerance too low (price moved), insufficient gas, or token-specific transfer taxes. Try increasing slippage to 1-2% or reducing the swap amount slightly.',
      },
    ],
  },
  {
    title: 'DCA (Dollar-Cost Averaging)',
    items: [
      {
        q: 'What is DCA?',
        a: 'DCA splits a large purchase into smaller, regular buys over time. Instead of buying 1 ETH at once, you could buy 0.1 ETH every day for 10 days. This reduces the impact of price volatility.',
      },
      {
        q: 'How does DCA work on TeraSwap?',
        a: 'Set your total amount, number of buys, and interval. TeraSwap executes each buy automatically at the best available rate. You can pause or cancel anytime.',
      },
    ],
  },
  {
    title: 'Limit Orders',
    items: [
      {
        q: 'How do limit orders work?',
        a: 'Set a target price at which you want to buy or sell. When the market reaches your price, the order executes automatically at the best rate. Orders are gasless to place — you only pay gas on execution.',
      },
      {
        q: 'How long do limit orders last?',
        a: 'You can set an expiry when creating the order. If the target price is never reached before expiry, the order cancels automatically with no cost to you.',
      },
    ],
  },
  {
    title: 'SL / TP (Stop-Loss & Take-Profit)',
    items: [
      {
        q: 'What are conditional orders?',
        a: 'Stop-Loss automatically sells when a token drops below a set price, protecting you from further losses. Take-Profit automatically sells when a token rises above a set price, locking in gains.',
      },
      {
        q: 'Can I set both SL and TP at the same time?',
        a: 'Yes. You can set a stop-loss floor and a take-profit ceiling on the same position. Whichever triggers first executes, and the other is cancelled.',
      },
    ],
  },
  {
    title: 'Security & Privacy',
    items: [
      {
        q: 'Is TeraSwap safe?',
        a: 'TeraSwap is a non-custodial frontend — your tokens never leave your wallet until you sign a transaction. We use Permit2 for gasless approvals and all swap routes go through audited DEX contracts. Multi-layer price protection (Chainlink + DefiLlama + cross-quote consensus) guards against manipulation.',
      },
      {
        q: 'Has TeraSwap been audited?',
        a: 'TeraSwap itself is a routing layer — it does not hold funds or run smart contracts. All swaps execute through the audited contracts of the underlying DEXs (Uniswap, Balancer, Curve, etc.). Our FeeCollector smart contract is deployed and verified on Etherscan.',
      },
      {
        q: 'How does TeraSwap protect my privacy?',
        a: 'All blockchain reads (balance checks, price feeds, transaction receipts) and aggregator API calls are routed through a server-side privacy proxy. Your IP address is never exposed to RPC providers like Alchemy or external DEX APIs. Only our server communicates with these services.',
      },
      {
        q: 'What data does TeraSwap collect?',
        a: 'Minimal. We do not track wallets, store private keys, or collect personal information. Your IP address is actively protected by our privacy proxy. See our Privacy Policy for full details.',
      },
    ],
  },
]
