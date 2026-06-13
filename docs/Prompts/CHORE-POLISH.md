# CHORE-POLISH — batched low-risk cleanup (7 independent items)

Each item = its OWN atomic SSH-signed commit so any one can be reverted alone. Branch
`chore/polish-batch` off latest origin/main. CI green, append FEEDBACK. None is a security gate; the
gitleaksignore + USDe items touch security-adjacent surfaces but are benign — verify, don't weaken.

## P1 — Remove confirmed-dead code
`uniswap.ts` (flagged dead in 9W), `useLimitOrder` + `useConditionalOrder` (legacy/unused per 9U
FEEDBACK; the live path is useOrderEngine). For EACH: grep the whole repo to PROVE zero imports/refs
(incl. tests, dynamic imports, string refs). Only remove files with ZERO usage. **Do NOT delete any
docs/ADR/incident/sprint/spec file** (CLAUDE.md rule #4 is about preserving decision records — this is
unused source code, git history preserves it). If anything is referenced even once, leave it and note
in FEEDBACK.

## P2 — Fix USDe checksum (9Y-I-01)
`DEFAULT_TOKENS.USDe` address has a non-canonical EIP-55 checksum (`isAddress(strict)` → false). Replace
with the canonical checksummed form via viem `getAddress(...)`. The address VALUE must be identical
(same 20 bytes) — only the casing changes. Add/extend the fixture test that pins majors to assert
strict checksum on every DEFAULT_TOKENS entry.

## P3 — ADR-012: copyleft-dependency avoidance (9Z-I-03)
Write `docs/ADR/ADR-012-avoid-transitive-copyleft-deps.md` (Status: Accepted). Context: 9Z found
RainbowKit 2.2.11 pulls `ua-parser-js` AGPL-3.0 (copyleft risk for a commercial dapp). Decision: avoid
transitive AGPL/GPL deps; RainbowKit pinned ≤2.2.10; check new bumps' transitive licenses. Reference
INC-2026-06-09-001 (qr@0.6.0) as the sibling "loose transitive range" lesson. Keep it short.

## P4 — Sitemap (9M leftover)
`robots.txt` points at `https://www.teraswap.app/sitemap.xml` which 404s. Either add a real
`app/sitemap.ts` (Next.js generated sitemap with the public routes) OR remove the robots.txt sitemap
line. Prefer adding `app/sitemap.ts`.

## P5 — Apex→www redirect 308 (9M leftover)
The apex→www redirect serves 307 (temporary); make it 308 (permanent) for SEO canonical correctness —
in `next.config` redirects (`permanent: true`). If the live redirect is Vercel-edge level, document the
Vercel domain setting in FEEDBACK instead.

## P6 — Swap-box active-chain logo (9Y leftover)
The chain selector shows chain logos (9Y); the swap box does not show the ACTIVE chain's logo. Add it
(reuse the bundled Ethereum/Base SVGs from 9Y, no external fetch). Cosmetic, both chains.

## P7 — .gitleaksignore for pre-existing history false-positives
A full-history gitleaks scan flags 44 PRE-EXISTING benign FPs (fake `sk_live_*` fixtures, a legacy
XOR-migration constant in `useOrderEngine.ts`, public addresses in `seed-10-trades.ts` — per 9Y
FEEDBACK). Add a `.gitleaksignore` with the specific FINGERPRINTS (not a broad `src/` allowlist) so a
full-history scan is clean. First re-confirm each is benign (no real secret). Keep the PR-scoped CI and
real scanning intact.

## Do NOT
- No swap/gate/FeeCollector/adapter/oracle/contract changes. Mainnet/Base byte-identical (P2 is a
  casing-only address fix; P6 is display-only). Keys server-only.
- 7 atomic SSH-signed commits (P1…P7), CI green, append FEEDBACK. No Auditor needed; flag in FEEDBACK
  if P1's dead-code check finds anything still referenced or P7 surfaces a real secret.
