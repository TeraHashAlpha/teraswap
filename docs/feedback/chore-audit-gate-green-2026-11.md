# chore/audit-gate-green-2026-11 — SEC-18: "CI / audit" and "Security Audit / audit" red on main

Long output: [`chore-audit-gate-green-2026-11.evidence.md`](chore-audit-gate-green-2026-11.evidence.md) (sections A–I).

## Owner answers (asked once, 2026-11-17; they supersede the goal text)
- Path: **time-boxed exception** (not "wait", not "remove Sentry + exception"). This overrides "`git diff` of the allow-list is empty".
- Form: **`noPatch: true` + `reviewDate: 2026-12-17`**, no `expires`.
- After verify (asked separately, red verify outside the diff): **push now**, the parity flake recorded here as main's.

## 1. Step 0 (origin/main `4a4129ef`, Node 22.23.5 / npm 10.9.9, `CI=true`, `npm ci`)
Both jobs run the identical step (`node scripts/audit-gate.mjs`): **same failure, one cause**, **GHSA-fc5q-39xc-vjpf**
picomatch, HIGH 7.5, `<= 4.0.7`, **first patched: none** (advisory updated 2026-11-17 15:56Z; upstream PR 194 open;
latest 4.0.7 of 2026-08-24; newest 2.x 2.3.2 also vulnerable). Options 1 and 2 of the goal were impossible.

| Entry path | picomatch | tree | in the shipped build? |
|---|---|---|---|
| @sentry/nextjs 10.78.0 → @rollup/plugin-commonjs 28.0.1 (+ pluginutils, fdir) | 4.0.7 | prod | no (0 client, 0 server chunks, 0/68 traces) |
| vitest 4.1.12 (+ tinyglobby 0.2.17, vite 8.1.6) | 4.0.7 | dev | no |
| tailwindcss 3.4.19 → chokidar 3.6.0 (anymatch, readdirp), micromatch 4.0.8 | 2.3.2 ×3 | dev | no |
| wagmi 2.19.5 → … WalletConnect → unstorage 1.17.5 → anymatch 3.1.3 | 2.3.2 | prod | no (anymatch only in `drivers/fs`; WC loads `fs-lite`) |
| next 16.4.5 vendored `next/dist/compiled/picomatch` (npm audit cannot see it) | bundled | prod | traced in `next-server.js.nft.json`; image matchers only, config patterns (none set) |

The exploit needs an attacker-**supplied glob**; every caller here gets its patterns from config. Premise corrected:
Sentry is 1 of 4 entry points and is imported (`src/app/global-error.tsx:3`, `next.config.js:1`, 3 `sentry.*.config.ts`);
removing it leaves the gate red (section F).

## 2. What changed
No package changed (no fixed version exists). `audit-allowlist.json` +1 entry, GHSA-fc5q-39xc-vjpf, `added 2026-11-17`,
`noPatch: true`, `reviewDate: 2026-12-17`, reason = the reachability above. Gate script, workflows, lockfiles: untouched.

## 3. Gates and audit counts (Node 22, exact workflow commands)
- before: `audit-gate: 2 high/critical advisories present, 1 allowlisted, 1 blocking.` → `audit-gate FAILED — 1 problem` (exit 1)
- after: `audit-gate: 2 high/critical advisories present, 2 allowlisted, 0 blocking.` → `audit-gate PASSED` (exit 0)
- `npm audit`: 52 (16 moderate, 36 high) before and after; `--omit=dev`: 34 (11 moderate, 23 high) before and after.
  Unchanged on purpose: an allow-list entry does not change the tree.

## 4. Suite, build, browser (Node 22)
- Full vitest suite 10845/0 (507 files), tsc 0, lint delta +0/+0, `next build` ok (section H). Keeper suite not run: no
  keeper file or lockfile changed.
- Chrome on the local production build of `d54bbc1a`, v1 and v2 (`UI_V2_ENABLED=true`): landing renders; `/swap` sell 0.5 ETH
  quotes (v1 ~914.70 USDC via Velora, v2 ~912.84 USDC via CoW); Connect wallet opens the modal; **0 console errors** (section I).

## 5. Verify
- `agent-verify.sh --codeql` at `d54bbc1a`: **RESULT FAIL (1 failed)**: v1v2-parity 121/2. Failing: `sounds-parity.swap.test.tsx`
  (first test timed out at 5 s on its cold module load; its sound events leaked into the second). Same file passed in the
  suite step of the same run, same SHA; known flake (`chore-tooling-leftovers-2026-11.md:41`). **Not rerun** (goal rule);
  outside the diff (the test does not read the allow-list). All other checks PASS; CodeQL 13→13, 0 new.
- `gen-claude-state.mjs --check`: current. gitleaks on the branch commits: no leaks.
- `diff --stat origin/main...HEAD`: 3 files, +397 −0 (`audit-allowlist.json` +10, this file, the evidence file). Code head
  `d54bbc1a`; HEAD is the commit that adds this text. Compare:
  https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-green-2026-11
- Not verified: CI itself (no polling; the owner reads it); the Security Audit daily cron; whether the test flakes on CI.

## Edge case (gate, not changed)
- `audit-gate.mjs` prints `RESOLVED … delete this allowlist entry` for minimatch, glob and uuid, yet all three are still
  in `npm audit` (moderate): the gate collects only high/critical, so every moderate/low entry reads as resolved.
  elliptic lives in the keeper lockfile, which this gate never audits.
- CLAUDE.md's hand-measured line "`audit-allowlist.json` holds 6 entries … Earliest expiry: 2026-11-22" (dated 2026-11-11)
  is now 7 entries, earliest date 2026-12-06; `gen-claude-state --check` does not cover it. Not edited (out of scope).
