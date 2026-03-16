# TeraSwap Security Architecture

## Privacy Layer

TeraSwap implements a privacy-preserving architecture that protects users' IP addresses from external blockchain infrastructure providers.

### RPC Privacy Proxy

All on-chain read operations from the browser are routed through a server-side proxy (`/api/rpc`) instead of directly calling RPC providers (Alchemy, LlamaRPC, etc.).

**Before:**
```
User's Browser → Alchemy RPC (user's real IP exposed)
```

**After:**
```
User's Browser → /api/rpc (Vercel server) → Alchemy RPC (only Vercel's IP visible)
```

**What's protected:**
- Token balance checks
- ERC-20 allowance reads
- Transaction receipt polling
- Chainlink price feed queries
- Custom token imports (symbol, name, decimals)

**What's NOT protected (by design):**
- Wallet's own RPC connection (MetaMask, Coinbase, etc.) — controlled by user's wallet settings
- Transaction signing and submission — handled by user's wallet directly

### RPC Proxy Security Features

- **Method whitelist**: Only read-only methods allowed (`eth_call`, `eth_getTransactionReceipt`, `eth_getBalance`, etc.). Write methods like `eth_sendRawTransaction` are blocked.
- **Rate limiting**: 60 requests per IP per minute to prevent abuse.
- **Automatic fallback**: If the proxy is unreachable, the client falls back to direct RPC (graceful degradation over total failure).

### API Proxy Architecture

All external aggregator API calls are also proxied server-side:

| External Service | Endpoint | User IP Hidden |
|-----------------|----------|---------------|
| 1inch, 0x, Paraswap, Odos, KyberSwap, CoW, OpenOcean, Sushi, Balancer | `/api/quote` | Yes |
| Swap calldata from all aggregators | `/api/swap` | Yes |
| Spender addresses | `/api/spender` | Yes |
| CoW Protocol order submission | `/api/orders` | Yes |
| Supabase analytics | `/api/log-*` | Yes |
| RPC reads (eth_call, receipts, etc.) | `/api/rpc` | Yes |

---

## Smart Contract Security

### Content Security Policy (CSP)

TeraSwap implements a strict CSP that:
- Blocks all iframes (`frame-src 'none'`, `frame-ancestors 'none'`) — clickjacking protection
- Restricts `connect-src` to a whitelist of known aggregator APIs, RPC endpoints, and WalletConnect
- Blocks all plugins/objects (`object-src 'none'`)
- Enforces HTTPS via HSTS with 2-year max-age and preload

### Router Whitelist

Before executing any swap, the frontend validates that the target contract address is a known DEX router:
- 1inch v6 AggregationRouter
- 0x Exchange Proxy
- Paraswap Augustus v6
- Uniswap V3 SwapRouter
- KyberSwap MetaAggregationRouter
- Odos RouterV2
- TeraSwap FeeCollector

Unknown router addresses are blocked.

### Function Selector Validation

Swap calldata is validated against a whitelist of known swap function selectors. Unknown selectors are blocked to prevent malicious calldata injection.

### Fee Integrity Check

After receiving swap calldata from an aggregator, TeraSwap verifies that the output amount is consistent with the quoted amount. If the swap output is suspiciously higher than quoted (indicating the partner fee may have been bypassed), the swap is blocked.

### Calldata Size Limits

Abnormally large calldata (>100KB) is rejected to prevent potential buffer overflow attacks.

### CoW Protocol Security

- Receiver address is validated to match the user's wallet
- Order `validTo` is capped at 30 minutes from submission
- Pre-flight balance and allowance checks before signing

---

## Error Monitoring (Sentry)

TeraSwap uses Sentry for error monitoring with privacy-conscious configuration:
- No cookies are sent to Sentry
- Wallet rejection errors are filtered (not noise-worthy)
- Network errors are filtered
- Browser extension errors are filtered
- 10% transaction sampling to stay within free tier

---

## Token Import Security

Custom token imports sanitize the on-chain `name()` and `symbol()` return values:
- HTML tags are stripped (XSS prevention)
- Only printable ASCII characters are allowed
- Length is capped (symbol: 20 chars, name: 64 chars)

---

## API Key Protection

- All API keys (1inch, 0x, Alchemy, Supabase service key) are server-side only (no `NEXT_PUBLIC_` prefix)
- `.env` files are excluded from git tracking
- `.env.example` contains only placeholder values

---

## Recommended User Security

For maximum security, we recommend:
1. Use a hardware wallet (Ledger, Trezor) for large balances
2. Use a privacy-focused RPC in your wallet (e.g., MEV Blocker, Flashbots Protect)
3. Revoke unlimited token approvals regularly (revoke.cash)
4. Never share your seed phrase or private keys
