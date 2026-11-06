# fix/chain-switch-token-fallback — FEEDBACK

Bug: `remapTokenToChain` returned the ORIGINAL token on a catalog miss → mainnet SNX stayed "on" Arbitrum (⚠, 1inch "not valid token", "No valid quotes").
Commits: `412dfb0` helper · `2d359cb` callers · `2fdec1e` guard (SHAs as of push; check `git log`). Compare: https://github.com/TeraHashAlpha/teraswap/compare/main...fix/chain-switch-token-fallback

## Checklist
- [x] C1 `remapTokenToChain` → null on miss; `getDefaultPair`, `remapPairToChain` · [x] C2 SwapBox effect + v2 SwapCard memo · [x] C3 guard v1+v2 · [x] evidence

## Owner answers / premise deltas
- **No persisted pair exists** (v1 or v2: in-memory state seeded from `findToken('ETH'/'USDC')`, no storage/URL). Owner: **skip persistence**. "Restore" = `remapPairToChain` as the single choke point + tests (stale {SNX mainnet, DAI} on Base/Arbitrum → default pair).

## Evidence
1. **Repro** (real Chromium, dev server, no wallet, sell 1 SNX, switch Ethereum → Arbitrum; shots in `docs/feedback/fix-chain-switch-token-fallback/`):
   before `before-arbitrum-snx.png` — sell still SNX `0xC011…2a6F`, ⚠ badge, `/api/quote?src=0xC011…&chainId=42161` · after `after-arbitrum-default-pair.png` — ETH ("Native asset", no ⚠) → USDC `0xaf88…`, quote `src=0xEeee…&dst=0xaf88…&chainId=42161`.
2. **Helper matrix** (`src/lib/chains/tokens.test.ts`, 14 new): mainnet SNX→Arb = Arb default; Base SNX 0x22e6 stays; DAI→Base = Base DAI; import-on-Base stays only on Base (null elsewhere); both→USDC = default; mainnet no-op (same objects); every leg of every 6×6×3 result ∈ catalog∪imports.
3. **Guard** (v1 `SwapBox.chain-switch-fallback`, v2 `swap-card.chain-switch-fallback`): 6 tokens × 30 pairs × all walks from each chain = 540 scenarios / 900 switches per UI → **0 violations**; against the old `?? token` behaviour: 504 (v1) / 750 (v2). ⚠ only for imports.
4. **Gates** vs CURRENT origin/main `40d5c52` (branch = origin/main merged in, `ed7ffd2`; base in its own worktree + `npm ci`, same lockfile): vitest base 438 files / 7815 → branch 440 / 7843 (+2 files, +28 tests, 0 fail; v1/v2 parity + rpc-budget included) · eslint 93 warn / 0 err on both (delta 0) · tsc clean · `next build` OK · CodeQL security-extended, both with `node_modules`: 10 → 10, **0 new / 0 fixed** · diff vs main `10 files, +738/−25` (+ screenshots). Same three gates were also green vs the branch's original merge-base `77447da` (430/7725 → 432/7753).

## Findings
- **Spec vs catalog**: symbol matching stays on the CURATED list (long-tail symbols can be clones); "belongs to chain" uses the full catalog ∪ chain-scoped imports. So mainnet SNX → Base does NOT reach Base SNX (catalogued, not curated) → default pair, which is what the spec's own restore test expects.
- **Residual (not fixed, quotes out of scope)**: v1 applies the remap in an effect, so the render right after a switch still calls `useQuote` once with the foreign pair (seen in the browser: one `src=0xC011…&chainId=42161` request before the default-pair one; it is dropped by the identity check). v2 derives, so it has none. Follow-up: derive in v1 too.
- Test-harness trap: SwapBox shows the TokenAddressBadge only when there is NO balance row; the copied `useBalance` mock hid it, which would have made every ⚠ assertion vacuous.
- Null INPUT leg = "nothing selected" (stays null); only a remap-lost leg or a collapse triggers the default pair. Unknown chain → `{null,null}`.
- LandingPage/Hero keep their explicit symbol check (outcome identical; LandingPage comment corrected). v2 not screenshotted (flag off by default) — proven by test.
- Dev rig: Arbitrum selectable only with `NEXT_PUBLIC_ARBITRUM_FEE_COLLECTOR` (public address, `docs/DEPLOYMENTS.md`); `next dev` rewrites `AGENTS.md` — restored, not committed.
