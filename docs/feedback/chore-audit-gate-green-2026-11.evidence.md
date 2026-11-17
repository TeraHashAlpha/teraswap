# chore/audit-gate-green-2026-11: evidence (companion to the feedback file)

All runs: Node 22.23.5 / npm 10.9.9 (the Node 22 that both workflows set up), `CI=true`, after `npm ci`.

## A. Gate on origin/main 4a4129ef (before)

Identical step in `ci.yml` job `audit` (lines 73-86) and `security-audit.yml` job `audit`.

```
node v22.23.5 npm 10.9.9 head 4a4129ef
npm ci exit 0
```

```
== CI / audit + Security Audit / audit: node scripts/audit-gate.mjs
audit-gate: 2 high/critical advisories present, 1 allowlisted, 1 blocking.
  ALLOWLISTED  HIGH     zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), expires 2026-12-22
  ⓘ RESOLVED  minimatch (GHSA-g3hv-75wg-m249) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  glob (GHSA-3g3m-2fjr-6pw4) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  uuid (GHSA-w5hq-g745-h8pq) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  elliptic (GHSA-848j-6mx2-7j84) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  deepmerge (GHSA-gcqx-w48m-w2h4) no longer appears in npm audit — delete this allowlist entry.

audit-gate FAILED — 1 problem:
  NOT allowlisted:
  HIGH  picomatch (GHSA-fc5q-39xc-vjpf) — picomatch vulnerable to ReDoS through single-branch repeated extglobs
      https://github.com/advisories/GHSA-fc5q-39xc-vjpf

Resolve via an npm `overrides` pin to a patched version. ONLY if the patch is blocked by
.npmrc min-release-age, add a justified, dated entry to audit-allowlist.json (Architect review).
gate exit 1
```

Security Audit's advisory step (`npm audit --audit-level=moderate || true`, continue-on-error):

```

To address all issues (including breaking changes), run:
  npm audit fix --force
moderate step exit 1 (continue-on-error in workflow)
```

## B. npm audit counts (before)

```
before.audit.json          {"info":0,"low":0,"moderate":16,"high":36,"critical":0,"total":52}
before.audit-omitdev.json  {"info":0,"low":0,"moderate":11,"high":23,"critical":0,"total":34}
```

## C. Advisory (gh api /advisories/GHSA-fc5q-39xc-vjpf, read 2026-11-17)

```
severity high, cvss3 7.5, published 2026-10-19T18:32:12Z, updated 2026-11-17T15:56:44Z
range <= 4.0.7, first_patched none
Picomatch through 4.0.7 contains a regular expression denial of service vulnerability that allows attackers to block the event loop by supplying single-branch repeated extglob patterns. Attackers can provide globs like +(*) or +(*a), which analyzeRepeatedExtglob in lib/parse.js skips, causing exponential backtracking against short crafted strings and denying service to Node.js applications.

Upstream fix PR micromatch/picomatch 194:
state open, merged false, created 2026-08-13T07:45:13Z, updated 2026-11-09T08:42:00Z: fix: treat a leading `?` in an extglob body as a wildcard

npm view picomatch time (2.3.x, 3.x, 4.x), dist-tag latest = 4.0.7:
  2.3.0 2021-05-22T01:49:20.438Z
  2.3.1 2022-01-02T17:18:24.430Z
  3.0.0 2023-10-29T00:58:21.803Z
  3.0.1 2023-10-29T08:12:50.118Z
  4.0.0 2024-02-08T02:22:12.147Z
  4.0.1 2024-02-08T02:31:53.301Z
  4.0.2 2024-03-28T03:23:11.348Z
  4.0.3 2025-07-15T19:39:26.492Z
  2.3.2 2026-03-23T20:39:08.118Z
  3.0.2 2026-03-23T20:39:33.214Z
  4.0.4 2026-03-23T20:39:47.960Z
  4.0.5 2026-07-02T16:47:23.026Z
  4.0.6 2026-08-24T14:29:55.167Z
  4.0.7 2026-08-24T14:36:23.690Z
```

## D. Every installed copy and path

```
teraswap@0.1.0 /Users/tiagocruz/ts-worktrees/audit-gate-green-2026-11
├─┬ @sentry/nextjs@10.78.0
│ └─┬ @rollup/plugin-commonjs@28.0.1
│   ├─┬ @rollup/pluginutils@5.3.0
│   │ └── picomatch@4.0.7 deduped
│   ├─┬ fdir@6.5.0
│   │ └── picomatch@4.0.7 deduped
│   └── picomatch@4.0.7 deduped
├─┬ tailwindcss@3.4.19
│ ├─┬ chokidar@3.6.0
│ │ ├─┬ anymatch@3.1.3
│ │ │ └── picomatch@2.3.2
│ │ └─┬ readdirp@3.6.0
│ │   └── picomatch@2.3.2
│ └─┬ micromatch@4.0.8
│   └── picomatch@2.3.2
└─┬ vitest@4.1.12
  ├── picomatch@4.0.7
  ├─┬ tinyglobby@0.2.17
  │ └── picomatch@4.0.7 deduped
  └─┬ vite@8.1.6 overridden
    └── picomatch@4.0.7 deduped

```

Production tree only (`npm ls picomatch --all --omit=dev`):

```
teraswap@0.1.0 /Users/tiagocruz/ts-worktrees/audit-gate-green-2026-11
├─┬ @sentry/nextjs@10.78.0
│ └─┬ @rollup/plugin-commonjs@28.0.1
│   ├─┬ @rollup/pluginutils@5.3.0
│   │ └── picomatch@4.0.7 deduped
│   ├─┬ fdir@6.5.0
│   │ └── picomatch@4.0.7 deduped
│   └── picomatch@4.0.7
└─┬ wagmi@2.19.5
  └─┬ @wagmi/connectors@6.2.0
    └─┬ @walletconnect/ethereum-provider@2.21.1
      └─┬ @walletconnect/keyvaluestorage@1.1.1
        └─┬ unstorage@1.17.5
          └─┬ anymatch@3.1.3
            └── picomatch@2.3.2

```

Declared picomatch range of each parent (installed version, range):

```
@rollup/pluginutils       5.3.0    picomatch ^4.0.2
@rollup/plugin-commonjs   28.0.1   picomatch ^4.0.2
fdir                      6.5.0    picomatch -
tinyglobby                0.2.17   picomatch ^4.0.4
vite                      8.1.6    picomatch ^4.0.5
vitest                    4.1.12   picomatch ^4.0.3
anymatch                  3.1.3    picomatch ^2.0.4
micromatch                4.0.8    picomatch ^2.3.1
readdirp                  3.6.0    picomatch ^2.2.1
```

## E. Shipped build output (`npm run build` on origin/main, Node 22, exit 0)

```
== client output (.next/static): files containing picomatch signatures
  [POSIX_REGEX_SOURCE] 0 file(s)
  [Expected pattern to be a non-empty string] 0 file(s)
  [anymatch: specify first argument] 0 file(s)
  [Input length: ] 0 file(s)
== server output (.next/server): files containing picomatch signatures
  [POSIX_REGEX_SOURCE] 0 file(s)
  [Expected pattern to be a non-empty string] 0 file(s)
  [anymatch: specify first argument] 0 file(s)
== Vercel function traces (*.nft.json): traced picomatch / anymatch / rollup files
  trace files: 68
  [node_modules/picomatch/] in 0 trace file(s)
  [node_modules/anymatch/] in 0 trace file(s)
  [node_modules/micromatch/] in 0 trace file(s)
  [node_modules/@rollup/] in 0 trace file(s)
  [node_modules/unstorage/] in 0 trace file(s)
  [next/dist/compiled/picomatch/] in 1 trace file(s)
      .next/next-server.js.nft.json
```

## F. Removing @sentry/nextjs (simulated on a copy: `npm uninstall @sentry/nextjs --package-lock-only`, then the gate)

```
lockfile entries before 1074, after 995
removed 79, added 0
removed, grouped by scope/name:
  @rollup 27
  @sentry 25
  @opentelemetry 8
  cjs-module-lexer 1
  commondir 1
  dotenv 1
  estree-walker 1
  glob 1
  minimatch 1
  import-in-the-middle 1
  es-module-lexer 1
  is-reference 1
  minipass 1
  module-details-from-path 1
  path-scurry 1
  lru-cache 1
  progress 1
  proxy-from-env 1
  require-in-the-middle 1
  rollup 1
  stacktrace-parser 1
  type-fest 1
picomatch-chain entries removed: node_modules/@rollup/plugin-commonjs@28.0.1, node_modules/@rollup/pluginutils@5.3.0, node_modules/@rollup/rollup-android-arm-eabi@4.60.4, node_modules/@rollup/rollup-android-arm64@4.60.4, node_modules/@rollup/rollup-darwin-arm64@4.60.4, node_modules/@rollup/rollup-darwin-x64@4.60.4, node_modules/@rollup/rollup-freebsd-arm64@4.60.4, node_modules/@rollup/rollup-freebsd-x64@4.60.4, node_modules/@rollup/rollup-linux-arm-gnueabihf@4.60.4, node_modules/@rollup/rollup-linux-arm-musleabihf@4.60.4, node_modules/@rollup/rollup-linux-arm64-gnu@4.60.4, node_modules/@rollup/rollup-linux-arm64-musl@4.60.4, node_modules/@rollup/rollup-linux-loong64-gnu@4.60.4, node_modules/@rollup/rollup-linux-loong64-musl@4.60.4, node_modules/@rollup/rollup-linux-ppc64-gnu@4.60.4, node_modules/@rollup/rollup-linux-ppc64-musl@4.60.4, node_modules/@rollup/rollup-linux-riscv64-gnu@4.60.4, node_modules/@rollup/rollup-linux-riscv64-musl@4.60.4, node_modules/@rollup/rollup-linux-s390x-gnu@4.60.4, node_modules/@rollup/rollup-linux-x64-gnu@4.60.4, node_modules/@rollup/rollup-linux-x64-musl@4.60.4, node_modules/@rollup/rollup-openbsd-x64@4.60.4, node_modules/@rollup/rollup-openharmony-arm64@4.60.4, node_modules/@rollup/rollup-win32-arm64-msvc@4.60.4, node_modules/@rollup/rollup-win32-ia32-msvc@4.60.4, node_modules/@rollup/rollup-win32-x64-gnu@4.60.4, node_modules/@rollup/rollup-win32-x64-msvc@4.60.4
picomatch copies left: node_modules/anymatch/node_modules/picomatch@2.3.2, node_modules/micromatch/node_modules/picomatch@2.3.2, node_modules/picomatch@4.0.7, node_modules/readdirp/node_modules/picomatch@2.3.2
```

```
audit-gate: 2 high/critical advisories present, 1 allowlisted, 1 blocking.
  ALLOWLISTED  HIGH     zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), expires 2026-12-22

audit-gate FAILED — 1 problem:
  NOT allowlisted:
  HIGH  picomatch (GHSA-fc5q-39xc-vjpf) — picomatch vulnerable to ReDoS through single-branch repeated extglobs
      https://github.com/advisories/GHSA-fc5q-39xc-vjpf

Resolve via an npm `overrides` pin to a patched version. ONLY if the patch is blocked by
.npmrc min-release-age, add a justified, dated entry to audit-allowlist.json (Architect review).
```

Production-only audit of that copy:

```
high/critical direct advisories: picomatch GHSA-fc5q-39xc-vjpf (<=4.0.7), zod GHSA-mrhx-c7xc-m3w5 (<4.6.6)
picomatch-chain packages flagged: anymatch, picomatch
metadata: {"info":0,"low":0,"moderate":7,"high":20,"critical":0,"total":27}
```

## G. Gate after the change (Node 22, `CI=true`, fresh `npm ci`; tree = 8929c632 + the allow-list edit, committed unchanged as d54bbc1a)

```
node v22.23.5 npm 10.9.9 head 8929c632
npm ci exit 0
== CI / audit + Security Audit / audit: node scripts/audit-gate.mjs
audit-gate: 2 high/critical advisories present, 2 allowlisted, 0 blocking.
  ALLOWLISTED  HIGH     picomatch (GHSA-fc5q-39xc-vjpf) — fix none (advisory first_patched: none; latest 4.0.7, newest 2.x 2.3.2), review by 2026-12-17
  ALLOWLISTED  HIGH     zod (GHSA-mrhx-c7xc-m3w5) — fix none for 3.x (4.6.6 only), expires 2026-12-22
  ⓘ RESOLVED  minimatch (GHSA-g3hv-75wg-m249) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  glob (GHSA-3g3m-2fjr-6pw4) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  uuid (GHSA-w5hq-g745-h8pq) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  elliptic (GHSA-848j-6mx2-7j84) no longer appears in npm audit — delete this allowlist entry.
  ⓘ RESOLVED  deepmerge (GHSA-gcqx-w48m-w2h4) no longer appears in npm audit — delete this allowlist entry.
audit-gate PASSED — no un-allowlisted high/critical advisories.
gate exit 0
```

```
after.audit.json           {"info":0,"low":0,"moderate":16,"high":36,"critical":0,"total":52}
after.audit-omitdev.json   {"info":0,"low":0,"moderate":11,"high":23,"critical":0,"total":34}
```

## H. scripts/agent-verify.sh --codeql (Node 22 on PATH)

```
=== EVIDENCE ===
branch: chore/audit-gate-green-2026-11 @ d54bbc1a (base origin/main @ 4a4129ef)
suite:       PASS 10845 tests passed, 0 failed, 507 files
lint-delta:  PASS errors +0, warnings +0 (0 changed files)
tsc:         PASS 0 errors
build:       PASS next build ok
v1v2-parity: FAIL exit 1; 121 passed, 2 failed, 11 files (log: scratchpad parity.log)
rpc-budget:  PASS 36 tests passed, 0 failed, 3 files
codeql:      PASS security-extended: head 13, base 13, new by rule+file+message 0
keeper:      SKIP not requested (--keeper)
diff --stat origin/main...HEAD:
 audit-allowlist.json                                     |  10 ++
 docs/feedback/chore-audit-gate-green-2026-11.evidence.md | 214 +++++++++++++++++++++++++++++++++++
 docs/feedback/chore-audit-gate-green-2026-11.md          |  34 ++++++
 3 files changed, 258 insertions(+)
compare: https://github.com/TeraHashAlpha/teraswap/compare/main...chore/audit-gate-green-2026-11
RESULT: FAIL (1 failed)
=== END EVIDENCE ===
```

v1v2-parity failure (`isolation parity` subset), verbatim. The same file passed in the `suite` step of this run
(507/507 files, 10845/10845) at the same SHA minutes earlier; not rerun (goal rule).

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/ui/v2/swap/sounds-parity.swap.test.tsx > quote-received sound: v2 = v1 > baseline: v1 plays a sub-bass + a ping (4 node events)
Error: Test timed out in 5000ms.
If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
 ❯ src/ui/v2/swap/sounds-parity.swap.test.tsx:116:3
    114|
    115| describe('quote-received sound: v2 = v1', () => {
    116|   it('baseline: v1 plays a sub-bass + a ping (4 node events)', async (…
       |   ^
    117|     const { sounds } = await freshPage()
    118|     sounds.playQuoteReceived()
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯
 FAIL  src/ui/v2/swap/sounds-parity.swap.test.tsx > quote-received sound: v2 = v1 > a quote arrives → exactly v1's sound, once
AssertionError: expected [ { op: 'start', …(2) }, …(3) ] to deeply equal [ { op: 'start', …(2) }, …(7) ]
- Expected
+ Received
@@ -17,26 +17,6 @@
    {
      "freq": 1200,
      "op": "stop",
      "type": "sine",
    },
-   {
-     "freq": 55,
-     "op": "start",
-     "type": "sine",
-   },
-   {
-     "freq": 55,
-     "op": "stop",
-     "type": "sine",
-   },
-   {
-     "freq": 1200,
-     "op": "start",
-     "type": "sine",
-   },
-   {
-     "freq": 1200,
-     "op": "stop",
-     "type": "sine",
-   },
  ]
 ❯ src/ui/v2/swap/sounds-parity.swap.test.tsx:133:17
    131|     h.quote = { ...h.quote, meta: q() }
    132|     rerender(<SwapCard />)
    133|     expect(log).toEqual(v1)
       |                 ^
    134|   })
    135|
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯
```

## I. Browser check (Chrome, local production build of d54bbc1a on :3100)

Build env: public values only: dummy `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (32 zeros) and the mainnet FeeCollector V2
address from docs/DEPLOYMENTS.md as `NEXT_PUBLIC_FEE_COLLECTOR`. v1 = `next start`; v2 = same build with `UI_V2_ENABLED=true`
(`src/proxy.ts:38-39` rewrites `/` to `/v2`). Console read with errors-only filter, tracking started before each page load.

| | landing `/` | `/swap`, sell 0.5 ETH → USDC | Connect wallet | console errors |
|---|---|---|---|---|
| v1 | renders | ~914.6988 USDC, best via Velora, 8 sources enabled / 4 queried, min. output 911.9547 | RainbowKit modal opens | 0 |
| v2 | renders | ~912.8449 USDC, best via CoW Protocol, compare (4 sources) | RainbowKit modal opens | 0 |
