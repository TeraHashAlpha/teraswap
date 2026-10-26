# feat/ui-v2-shell — FEEDBACK
Flow-B: code only in `src/ui/v2/**`, `src/proxy.ts`(+test), this file. Off origin/main `d4b43db` (B0 #606 merged: `src/ui/v2/version.ts` present).
- [ ] C1 shell + feedback · [ ] C2 photos + fonts · [ ] C3 sounds + proxy + mobile · [ ] verify · [ ] evidence 1–7

## Premises checked / decisions (recorded)
- `useQuoteChainId` is exported from `src/hooks/useChainId.ts` (no `useQuoteChainId.ts` file). Used as-is, read-only.
- **Arbitrum DCA is dark** (`isDcaLive(42161)` = false, `DCA_CHAINS` ≠ live). The dropdown subtitle and the Ethereum DCA gate
  ("DCA runs on …") are therefore driven by `isDcaLive` / `dcaLiveChainNames()`, not typed: today Arbitrum reads "Swap" and the gate
  says "DCA runs on Base."; both flip to the spec text ("Swap · DCA", "…Base and Arbitrum One.") with no edit when its executor is wired.
  Typing it now would publish a claim `product-claims.ts` exists to prevent. If the owner wants the literal text anyway, it is a 1-line change.
- Out-of-list reads (needed to mirror v1 faithfully; read-only, none edited): `app/{page,swap/page,providers,layout}.tsx`,
  `components/{ChainSelector,icons/ChainIcon}.tsx`, `lib/{chains/registry,chains/activation,format,constants,help-content}.ts`,
  `lib/order-engine/limit-launch.ts` (`isLimitLive`), `hooks/useOrderNotifications.ts` (`useNotificationPrompt`), `next.config.js` (images),
  `tailwind.v2.config.ts`, `package.json` (grep), pack `round4/desktop/30a` + `mobile/m05,m09`.
- Root `providers.tsx` wraps `/v2` in v1's `ToastProvider` + `BackgroundMusic` (v1-styled ♫). Not editable (Flow-B) → v2 ships its own
  toast provider (same API as v1) and ♫; see C3 for the v1-♫ handling.
- Pack: toast motion text says 180 ms, B0 token `--t-toast` is 160 ms (ARCHITECT_BRIEF.md:24) → token kept. Pack footer carries a second
  sentence (“Provided as is…”) that is not in v1's `Footer` and not in the verbatim list → omitted; owner to decide.

## Content-map delta (header / footer, v1 → v2) — filled at verify
