# CHORE-AUDIT-GATE-SHARP — pin `sharp` to clear GHSA-f88m-g3jw-g9cj (repo-wide audit gate red)

> **Source:** owner report 2026-07-21 — the CI audit gate (`scripts/audit-gate.mjs`) fails repo-wide,
> blocking every open PR: HIGH `GHSA-f88m-g3jw-g9cj` — `sharp` inherited libvips CVEs
> (CVE-2026-33327/33328/35590/35591). `sharp` is an **optionalDependency of `next`** (image-optimization
> build/tooling path, not a direct dependency, no runtime fund-flow exposure). Per the gate's own policy
> (`audit-allowlist.json` header): resolve via an `overrides` pin to a patched version; allowlist ONLY if
> the patch is `<7d` old (`.npmrc` `min-release-age=7`).

## Investigation
- `npm audit --json` → exactly one high finding: `sharp <0.35.0` (via `next`'s optional dependency),
  `GHSA-f88m-g3jw-g9cj`, fixed in `sharp@0.35.0` (bundled `@img/sharp-libvips-*` bumped 1.2.4 → 1.3.0+).
- Latest `sharp@0.35.3` published **2026-07-01** (per `npm view sharp time`) — 20 days old as of
  2026-07-21, well past the 7-day `min-release-age` floor. Qualifies for a direct `overrides` pin.

## Change
- `package.json` `overrides`: added `"sharp": "0.35.3"` (exact pin, matches `save-exact=true` convention
  and every other override in the block). Zero other dependency changes — the lockfile diff is scoped to
  `sharp`/`@img/sharp-*`/`@img/sharp-libvips-*` version bumps plus `semver` deduping to a version
  (`7.8.5`) already required elsewhere in the tree (`@capacitor/cli`), not a new/unrelated bump.
- `audit-allowlist.json`: **untouched** — no entry needed, the direct pin fully resolves the finding.

## Verification
- `npm ls sharp --all` → `sharp@0.35.3 overridden` (single node, no stray unpinned copy).
- `node scripts/audit-gate.mjs` → `0 high/critical advisories present, 0 allowlisted, 0 blocking` → PASSED.
- `npm run build` → succeeds; `node -e "require('sharp').versions"` → `sharp 0.35.3`, `vips 8.18.3`
  (confirms the image-optimization dependency actually loads, not just resolves in the lockfile).
- Full suite: TS tests green, `tsc --noEmit` clean, `npm run lint` 0 errors (only pre-existing warnings
  in untouched files).

## Do NOT
Touch other dependencies or existing allowlist entries; modify `audit-gate.mjs` logic; open a PR.
