# Feedback — chore/audit-overrides-2026-09-09

## Task 1+2 — one row per advisory

| Advisory | Pkg | Vulnerable range | First patched | Published | Age today (2026-09-09) | Age-gate (≥7d) | Resolved today | Dep type |
|---|---|---|---|---|---|---|---|---|
| [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36) — RCE on Windows-hosted servers | next | `>=16.0.0 <16.3.3` (repo is on the 16.x line; advisory also lists `>=13.4.0 <15.5.24` for the 15.x line) | **16.3.3** | 2026-08-25 | 15 days | ✅ PASS | 16.2.11 | Direct (`dependencies.next`) |
| [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) — RCE in Image Optimization API via AVIF | next | `>=16.0.0 <16.3.3` (also `>=10.0.0 <15.5.24` for the 15.x line) | **16.3.3** | 2026-08-25 | 15 days | ✅ PASS | 16.2.11 | Direct (`dependencies.next`) |
| [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) — libheif vulns ([GHSA-g89c-p67h-r497](https://github.com/advisories/GHSA-g89c-p67h-r497), [GHSA-2jg2-4ch7-h545](https://github.com/advisories/GHSA-2jg2-4ch7-h545)) | sharp | `<0.35.4` | **0.35.4** | 2026-08-26 | 14 days | ✅ PASS | 0.35.3 → **0.35.4** (this PR) | Transitive `optionalDependency` of **next** (`node_modules/next` → `optionalDependencies.sharp`) |

Vulnerable ranges and first-patched versions read via `gh api /advisories/<id>`. Publish dates read from `https://registry.npmjs.org/{next,sharp}` `time` field. Resolved-today versions read from `package-lock.json` `packages["node_modules/{next,sharp}"].version` before this PR's change.

## Task 3 — Dependabot coverage

- **GHSA-p293-qw3h-jr36** and **GHSA-2xp9-vwfh-vxw4** (both `next`, both fixed by 16.3.3): **already covered.** `origin/dependabot/npm_and_yarn/next-16.3.3` (commit `0cf1c7c`, 2026-09-07) bumps `dependencies.next` `16.2.11` → `16.3.3` directly — a one-line `package.json` diff plus the matching lockfile update. **Not duplicated here** — the owner merges that branch.
- **GHSA-rgj7-g3m4-5g8c** (`sharp`): **not covered by any open dependabot branch.** Checked all five `dependabot/npm_and_yarn/*` branches on origin (`next-16.3.3`, `dev-dependencies-*`, `sentry/nextjs-10.72.0`, `supabase/supabase-js-2.112.4`, `viem-2.56.1`) — none touch `next`'s `optionalDependencies.sharp` (dependabot doesn't propose bumps for a nested optional transitive dep whose parent's manifest range already permits it). This is the one item left for this PR.

## Task 4 — the pin, and the gate

Changed **only**: `package.json` `overrides.sharp` `"0.35.3"` → `"0.35.4"` (was already an override, pre-existing from an earlier hardening pass — not newly added), then `npm install` (not `npm ci`, not `audit fix`) to refresh the lockfile. Lockfile diff is 244 lines, entirely inside the sharp dependency tree (`sharp`, all 20 `@img/sharp-*` platform binaries 0.35.3→0.35.4, `@img/sharp-libvips-*` 1.3.2→1.3.3, and `@emnapi/runtime` ^1.11.1→^1.11.3 pulled in by the new sharp release). Verified `next` unchanged in the lockfile (`16.2.11` before and after). No entry touched or added in `audit-allowlist.json`.

**Gate, before** (fresh `origin/main` clone, `npm ci`):
```
audit-gate: 3 high/critical advisories present, 0 allowlisted, 3 blocking.

audit-gate FAILED — 3 high/critical advisories are NOT allowlisted:
  CRITICAL  next (GHSA-p293-qw3h-jr36) — Next.js: Unauthenticated Remote Code Execution on windows-hosted servers
  CRITICAL  next (GHSA-2xp9-vwfh-vxw4) — Next.js: Unauthenticated Remote Code Execution in Image Optimization API when AVIF files are used
  HIGH  sharp (GHSA-rgj7-g3m4-5g8c) — sharp: Vulnerabilities in libheif: GHSA-g89c-p67h-r497 and GHSA-2jg2-4ch7-h545
```

**Gate, after** (this PR's `sharp` override applied):
```
audit-gate: 2 high/critical advisories present, 0 allowlisted, 2 blocking.

audit-gate FAILED — 2 high/critical advisories are NOT allowlisted:
  CRITICAL  next (GHSA-p293-qw3h-jr36) — Next.js: Unauthenticated Remote Code Execution on windows-hosted servers
  CRITICAL  next (GHSA-2xp9-vwfh-vxw4) — Next.js: Unauthenticated Remote Code Execution in Image Optimization API when AVIF files are used
```

### Concern — acceptance criterion 1 ("gate passes locally") is not met on this branch, by design

`sharp` is resolved (3 blocking → 2). The gate **does not go to exit 0 / passing** on this branch, because the two remaining blockers are `next`'s, and Task 3 explicitly says not to duplicate the open dependabot fix, and Task 4 says "change no other dependency version." There is no way to satisfy all four constraints at once — gate-passes, don't-touch-next, don't-allowlist, don't-run-audit-fix — because `next` is a **direct** dependency: the only two ways to change what version resolves are (a) edit `dependencies.next` directly, which is exactly dependabot's already-open fix, or (b) an `overrides` pin, which would be a second, redundant mechanism resolving the same package to the same version — duplication in substance even if not in form, and both are excluded. I did not invent a third path (no allowlist entry, no `next` edit). **The gate only reaches 0 blocking once `dependabot/npm_and_yarn/next-16.3.3` is merged alongside this branch** — that merge is the owner's call per Task 3, not mine to make here.

## Task 5 — exposure (does not change what got patched; changes urgency)

- **GHSA-p293-qw3h-jr36 (Windows-hosted RCE): NOT reachable in this deployment.** Production runs on Vercel, which executes Next.js on Linux (Vercel Functions/Fluid Compute); every CI workflow job in `.github/workflows/*.yml` runs `runs-on: ubuntu-latest` (33 jobs checked, zero `windows-*` runners). The only place this could matter is a contributor running `next dev`/`next start` on a Windows laptop — a dev-machine risk, not a production or CI one.
- **GHSA-2xp9-vwfh-vxw4 (AVIF RCE in Image Optimization API): NOT reachable via this app's own configuration.** `next.config.js`'s `images` block sets only `remotePatterns` (`tokens.1inch.io`, `assets.coingecko.com`) — no `images.formats` key, so Next's default output format stays `['image/webp']`; AVIF is never offered or requested. Repo-wide grep for `avif` (src/, app/, config files) returns zero hits. Caveat: this closes the *output-negotiation* path, not necessarily the *input* path — Next's image optimizer decodes whatever bytes the two remote hosts return regardless of our output-format setting, so a compromised or malicious response from `tokens.1inch.io`/`assets.coingecko.com` serving an AVIF payload would still reach the decoder. Both are established, reputable vendor CDNs, but this repo doesn't control them — which is also why patching (not just "we don't request AVIF") is still the right call for both `next` and `sharp`.
- **GHSA-rgj7-g3m4-5g8c (sharp/libheif): reachability follows the same input-side caveat above** — sharp is the decoder Next's Image Optimization API calls into, invoked on the raw bytes fetched from the two remote hosts above, independent of our own `formats` output setting. Same two trusted-but-external CDNs as the caveat above; no local HEIF/HEIC ingestion path exists elsewhere in the repo (grep for `heic`/`heif` also returns zero hits).

## What could not be fixed here, and exactly why

**`next` (GHSA-p293-qw3h-jr36, GHSA-2xp9-vwfh-vxw4) — not fixed on this branch**, per explicit instruction: Task 3 says an existing dependabot branch (`dependabot/npm_and_yarn/next-16.3.3`, already satisfies the 7-day age gate at 15 days old) already resolves both, and not to duplicate it; Task 4 says change no other dependency version. Fixing it is one `npm merge` away, on `origin/dependabot/npm_and_yarn/next-16.3.3` — not blocked by policy, just intentionally left to that branch.

---

## Amendment — Architect resolution of the Acceptance-1 conflict

The Architect's own read of the previous section: Acceptance 1 ("gate passes locally") cannot
hold alongside Task 3 ("don't duplicate dependabot") and the original Do-NOT ("change no other
dependency version") — confirmed correct, conflict was in the spec, not the execution. Resolved
here in favour of one green PR, per Architect instruction, after one empirical check.

### Q1 — does next@16.3.3 alone drag sharp to a patched version?

Two different answers depending on what "alone" means, and the gap between them is the whole
story:

1. **In the abstract** (next@16.3.3's own manifest, no override in the way): `next@16.3.3`
   declares `optionalDependencies.sharp: "^0.35.3"` (read from
   `https://registry.npmjs.org/next/16.3.3`). Bumping `next` to 16.3.3 **with the sharp override
   removed** and reinstalling resolves `sharp` to **0.35.4** on its own — npm's normal semver
   resolution picks the highest 0.35.x satisfying `^0.35.3` that also clears
   `.npmrc min-release-age=7` (0.35.4, 14 days old; nothing newer in the 0.35.x line existed to
   consider). `node scripts/audit-gate.mjs` → **0 blocking** in this configuration.

2. **On the actual, currently-open `origin/dependabot/npm_and_yarn/next-16.3.3` branch, as
   committed**: checked out into an isolated clone and ran `npm ci` + the real gate script.
   Result: **sharp resolves to 0.35.3** (the vulnerable version) and the gate reports
   **1 blocking** (`HIGH sharp GHSA-rgj7-g3m4-5g8c`) — `next`'s two CRITICALs are gone, sharp's
   HIGH is not. Reason: that branch's `package.json` still carries the **pre-existing**
   `overrides.sharp: "0.35.3"` entry (present in `origin/main` before either of these branches
   existed) — dependabot's tooling bumped only the `next` dependency line, it did not touch or
   remove that override, and an `overrides` pin always wins over a dependency's own declared
   range. So next's `^0.35.3` is silently overruled back down to the exact vulnerable version.

**This is answer (2) that matters** — it's the artifact the owner would actually merge — and it
is the "does NOT" case, not the "does" case the question was hedging against. Merging the
dependabot branch alone, unmodified, would still leave the gate red.

### Branch taken: keep the sharp override AND bump next — this branch supersedes dependabot's

Per the Architect's own ELSE instruction. On top of `a780567` (sharp override 0.35.3→0.35.4):
bumped `dependencies.next` `16.2.11` → `16.3.3` (byte-identical version target to
`dependabot/npm_and_yarn/next-16.3.3`'s own change), refreshed the lockfile. Diff: one line in
`package.json`, plus `package-lock.json` confined to `next`, its `@next/swc-*` platform binaries,
`@next/env`, `@swc/helpers` (0.5.15→0.5.23), and `postcss` (8.4.31→8.5.23, next's own bundled
dependency — matches `next@16.3.3`'s registry manifest exactly). `sharp` itself is untouched by
this commit (already at 0.35.4 from `a780567`) and resolves to 0.35.4 in the refreshed lockfile.

**Gate, before this commit** (at `a780567`, sharp fixed / next not): `2 high/critical, 0 allowlisted, 2 blocking` (both `next` CRITICALs).
**Gate, after this commit**: 
```
audit-gate: 0 high/critical advisories present, 0 allowlisted, 0 blocking.
audit-gate PASSED — no un-allowlisted high/critical advisories.
```

Suite: 263 files / 3793 tests, all green (unchanged). Typecheck: clean. Lint: 94 warnings, 0
errors — matches today's baseline exactly. `audit-allowlist.json`: untouched.

### What the owner should merge, and in what order

**Merge this branch (`chore/audit-overrides-2026-09-09`) only.** It is now self-sufficient — 0
blocking on its own — and it supersedes `dependabot/npm_and_yarn/next-16.3.3`, which resolves to
the identical `next` version but, merged alone, would leave `sharp`'s HIGH open (verified above).
Close or let dependabot auto-close the `next-16.3.3` PR once this merges (same target version, no
conflict expected); do not merge both, since npm would end up processing next's version bump from
two different branches for no additional benefit — this branch already carries it.
