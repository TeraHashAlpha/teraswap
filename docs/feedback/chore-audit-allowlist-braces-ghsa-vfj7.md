# Feedback — chore/audit-allowlist-braces-ghsa-vfj7

Goal: allowlist GHSA-vfj7-8cjw-p6xm (`braces` <=3.0.3, no patched release) so `CI / audit` and `Security Audit / audit` pass again.

## Checklist
- [x] (a) dependency paths + dev/prod classification
- [x] (b) production audit reachability
- [x] (c) registry proof of no patched release
- [x] (d) call-site grep + attacker-controllability
- [ ] Commit 2: allowlist entry + gate PASS line
- [ ] Commit 3: follow-up marker
- [ ] Push branch, report compare link

## Evidence (commit 1)

### (a) Dependency paths
`npm ls braces --all --package-lock-only` (lockfile tree; see caveat below):
```
└─┬ tailwindcss@3.4.19
  ├─┬ chokidar@3.6.0
  │ └── braces@3.0.3
  └─┬ micromatch@4.0.8
    └── braces@3.0.3 deduped
```
- Only top-level parent: `tailwindcss` → **devDependencies** (`"dev": true` on `node_modules/braces` in package-lock.json:7375).
- Caveat: plain `npm ls` in this worktree is unreliable because `node_modules` is symlinked from the main checkout; it reports "extraneous" for packages the lock does not list. The lockfile tree is authoritative.

### (b) Production reachability
`npm audit --omit=dev --audit-level=high --json` → no high/critical rows; `braces` absent from the prod graph.
**Classification: dev-only.**

### (c) No patched release
`npm view braces dist-tags` → `latest: 3.0.3`
`npm view braces versions time` (last 3): `3.0.1` 2019-04-10 · `3.0.2` 2019-04-16 · `3.0.3` 2024-05-21
No version above 3.0.3 exists → `overrides` pin is impossible.

### (d) Exploitability / call sites
`grep -rnE "micromatch|braces|fast-glob|chokidar" src scripts contracts/order-engine`: **no code imports or calls these packages.** Hits are prose only ("belt and braces") plus an error string (`scripts/verify-arbitrum-chainlink-feeds.mjs:108`). `contracts/order-engine/package-lock.json` has chokidar@4 and no braces entry.
Only brace-expansion input in the chain: `tailwind.config.ts` `content: ['./src/**/*.{js,ts,jsx,tsx,mdx}']` — a fixed build-time literal, not attacker-controlled.
**Verdict: no runtime attacker-controlled pattern.**

## Observations for Architect (not acted on)
- Full `npm audit` lists 7 high rows (braces, chokidar, micromatch, tailwindcss, fast-glob, eslint-config-next, @next/eslint-plugin-next). The gate counts **1 unique advisory**: all others propagate the same GHSA.
- `npm audit`'s suggested fixes are not viable: `tailwindcss@4.3.3` (major) and `eslint-config-next@15.5.27` (downgrade). Not applied.
- Policy tension: `audit-allowlist.json` `$comment` and the gate header say allowlist entries are only for *published* fixes held back by `min-release-age`. This advisory has **no** fix, so it falls outside that wording. Proceeding per the goal's explicit dated-justification exception.
