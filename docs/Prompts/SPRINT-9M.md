# SPRINT-9M — Host canonicalization (www) + @next/swc lockfile hygiene

Two independent post-9K hygiene items, each its OWN atomic signed commit. Branch
`feat/sprint-9m-host-and-lockfile` off latest `origin/main`.

## M1 — Canonical host = www.teraswap.app (owner decision 2026-06-03)
Today there's a host mismatch: WalletConnect `metadata.url` is `https://www.teraswap.app` (set in 9K)
but `layout.tsx` canonical is the apex `teraswap.app`. Both are allowlisted in Reown, but origin ⇔
canonical ⇔ WC metadata should be ONE host to avoid Verify/SEO edge cases. **Chosen host: `www`.**

Requirements:
- Set the canonical/`metadataBase` (and any OG/Twitter/sitemap/robots URLs) in `layout.tsx` (and
  wherever else the apex is referenced) to `https://www.teraswap.app`. Grep the repo for
  `teraswap.app` to find every reference; align them all to `www`.
- Ensure apex `teraswap.app` → `www.teraswap.app` is enforced as a redirect so only one host serves
  (via `next.config` redirects, or document it as a Vercel domain-level redirect for the owner if it
  can't be done in-repo). The serving origin must match the canonical + WC metadata.
- Do NOT change WC metadata (already www) or any 9K work. No behaviour change beyond host alignment.
- Verify build + tests green; note any owner-side Vercel domain step in FEEDBACK.

## M2 — @next/swc platform optionals persist across darwin npm install
9K/9L had to manually preserve the 8 `@next/swc` platform optional packages in the lockfile because a
darwin (`macOS`) `npm install` prunes them, dropping the Linux binaries that Vercel/CI need. Make this
persistent so it doesn't recur and Linux CI never breaks.

Requirements:
- Investigate and apply the proper project-level mechanism so all `@next/swc` platform optionals stay
  in `package-lock.json` regardless of the install OS (e.g. an `.npmrc` setting, pinning the platform
  packages as `optionalDependencies`, or npm config — pick the cleanest that survives a plain
  `npm install` on darwin AND keeps `npm ci` green on Linux).
- Confirm: after a darwin `npm install`, the lockfile still contains all 8 platform optionals; `npm ci`
  on a clean checkout resolves them; `next build` works on Linux CI.
- Document the chosen mechanism in FEEDBACK.

## Cross-cutting
- Two separate atomic SSH-signed commits (M1, M2). CI green. Mainnet/Base byte-identical. Keys
  server-only. Not a security gate → no Auditor; Preview-test before prod.
