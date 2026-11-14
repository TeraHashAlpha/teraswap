# Feedback: feat/dca-feed-candidates-weekly

Checklist (ticked as done):
- [ ] C1 `scripts/dca-feeds/candidates.ts` + tests on recorded fixtures
- [ ] C2 new candidates added to `src/config/dca-feed-registrations.json` as `enabled:false, action:none, phase:2`
- [ ] C3 `.github/workflows/dca-feed-candidates.yml`
- [ ] C4 runbook "Monthly batch" section
- [ ] Verify: both tables, `agent-verify.sh --codeql`, `gen-claude-state.mjs --check`

## 1. Premise check
- `feat/dca-feed-batch-2026-11` IS on origin/main (PR #688, merge 130f2ddf). Branch cut from it.
- TRUE: `batch.ts` reads Chainlink's directory. FALSE as worded: it has no reusable "reader" (the fetch is inline in
  `batch.ts`), so the host/path table moves to `scripts/dca-feeds/directory.ts` and `batch.ts` imports it; the rules are
  reused from `batch-lib.ts` (`isPlainProxy`, `liveProblems`, `MAX_STALENESS_RULE`).
- FALSE: "match by the directory's token address". The directory has NO token address on any entry (193 Base entries
  inspected 2026-11-14: keys are `proxyAddress`/`contractAddress`/`secondaryProxyAddress` = feeds only; `docs.baseAsset`
  is a symbol). Asked once; owner answered: exact symbol join as in `batch.ts` (one verified EIP-55 catalog token with
  that symbol, else "needs manual match", never a candidate). The token address always comes from OUR catalog.
- Directory URL (host fixed in code, no argument reaches it):
  `https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json` and
  `.../feeds-ethereum-mainnet-arbitrum-1.json`.
