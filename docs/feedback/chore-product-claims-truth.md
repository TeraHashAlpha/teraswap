## Feedback — CHORE-PRODUCT-CLAIMS-TRUTH

### Edge case
- The landing constellation now labels `ADAPTER_REGISTRY` `name` values (`cowswap`, `uniswapv3`, …) instead of the previous pretty 10-name marketing list. The count is honest; the labels are less pretty. Owner can add a display-name map later — that map would be another hand-maintained fact, so it was not invented here.
- DocsPage still mentions Ethereum Mainnet in order-engine deployment notes (which executor is wired). Those are not live-status claims and the hex on those lines was not touched.

### Test gap
- None beyond the shipped checker. `/swap` and `/app` had no hard-coded source/chain claims; they are still scanned.
