# feat/ui-v2-swap-card — feedback (B3)

Branch off origin/main `96e2e0b` (B1b merged). Dedicated worktree `~/ts-worktrees/ui-v2-swap-card`, real `npm ci`. No PR (owner opens it). Commits SSH-signed, noreply. Diff only under `src/ui/v2/**` + this file; v1 hooks/lib/api untouched.

## Checklist
- [x] C1 states 21a / 21b / 20 · [ ] C2 tier notices + CTA (24 / 29) · [ ] C3 per-photo scrim + real bg-zakim · [ ] evidence 1–7

## Premises / owner answers (supersede the goal text)
- Goal says `src/hooks/useQuoteChainId.ts`; `useQuoteChainId` lives in `src/hooks/useChainId.ts` (no such file). Reused unchanged.
- `docs/feedback/feat-ui-v2-swap-card.md` did not exist; created here.

## Decisions / deviations (each pinned by a test)
- **Min. output** = `deriveMinimumOutput` (bigint bps — the floor useSwap derives and SwapBox's unpriced dialog shows), not v1 QuoteBreakdown's float `out × (1 − s/100)`. Same 4-dp text on the fixtures; differs only past float precision. Auditor: this is the displayed floor, not the signed one (B4 review shows the frozen quote's).
- **Stale amount (new, beyond #604's pair identity):** v1 keeps a pair's quote on screen while a new amount is typed and divides its output by the NEW amount. v2 shows a quote only while its echoed `amountRaw` is the amount in the field; otherwise "quoting" (skeleton, CTA disabled). Rate/fee/min/receive can never describe another sell amount.
- **Route**: any `0x…{40}` inside a hop (v1 only caught a hop that IS an address) falls back to the source label.
- Est. gas is USD first (owner/v1 F3), the frame shows ETH first.
- Receive amount reuses v1's `DigitRoller` unchanged; its v1-Tailwind markup is laid out by `swap.css` (v2 stylesheet lacks those utilities).
- B4/B5 stubs, all real controls: token buttons (`data-b4-stub="token-modal"`, goal only named ✎), Max-slippage ✎, the CTA click (`data-b5-stub`). Slippage is auto (v1 default) and derived, not stored. Untrusted `/api/spender` answer is dropped silently (v1 also toasts).
- Not in this slice (B5 price gates): oracle-unavailable warn/block banners, price-impact + depeg consent, DefiLlama guard, split visualiser, simulation/tx/share lines. The CTA therefore reads Review swap where v1's gates would block; nothing can execute (no click path).
- Frame copy not in v1 and not a slot (idle "QUOTE BREAKDOWN" heading + hint, trust chips, `STATE:` notes) is omitted per "no copy beyond slots".
- Existing shell tests (`shell`, `round7`, `sounds-parity`) stub `SwapCard` (they test the shell); the `panes` test no longer lists swap as a placeholder.

## Content-map delta (v1 → v2, quote state)
0 v1 strings lost (`content-parity.swap.test.tsx`, 5 variants). Allow-list = 6 decorative glyphs (`⇅ ⟳ ✎ ⓘ ⚙ ×`), aria-hidden in v2, control keeps its name. New v2-only text: none.
