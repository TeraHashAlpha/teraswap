# chore/audit-gate-green-2026-11 — SEC-18: "CI / audit" and "Security Audit / audit" red on main

Long output: [`chore-audit-gate-green-2026-11.evidence.md`](chore-audit-gate-green-2026-11.evidence.md).

## Checklist
- [x] Step 0: both gates reproduced on origin/main `4a4129ef` (Node 22.23.5 / npm 10.9.9, `CI=true`, `npm ci`)
- [x] Paths, prod/dev, build-output grep, fixed-version search
- [ ] Owner answer (step 3: no fixed version exists, so options 1 and 2 are impossible)
- [ ] Change per answer, gates after, suite / tsc / lint / build / browser, verify, push

## 1. Step 0
Both jobs run the identical step (`npm ci`, then `node scripts/audit-gate.mjs`): **same failure, same single cause**.
`audit-gate: 2 high/critical advisories present, 1 allowlisted, 1 blocking.` The blocker is **GHSA-fc5q-39xc-vjpf**
picomatch, HIGH 7.5, vulnerable `<= 4.0.7`, **first patched: none** (advisory updated 2026-11-17 15:56Z; upstream fix
micromatch/picomatch PR 194 still open; latest release 4.0.7, 2026-08-24; newest 2.x is 2.3.2, also vulnerable).

| Entry path (`npm ls picomatch --all`) | picomatch | tree | in the shipped build? |
|---|---|---|---|
| @sentry/nextjs 10.78.0 → @rollup/plugin-commonjs 28.0.1 (+ pluginutils 5.3.0, fdir 6.5.0) | 4.0.7 | prod | no: 0 client chunks, 0 server chunks, 0 of 68 traces |
| vitest 4.1.12 (+ tinyglobby 0.2.17, vite 8.1.6) | 4.0.7 | dev | no |
| tailwindcss 3.4.19 → chokidar 3.6.0 (anymatch, readdirp), micromatch 4.0.8 | 2.3.2 ×3 | dev | no |
| wagmi 2.19.5 → … WalletConnect → unstorage 1.17.5 → anymatch 3.1.3 | 2.3.2 | prod | no: unstorage loads anymatch only in `drivers/fs`; WalletConnect loads `drivers/fs-lite` |
| next 16.4.5, vendored `next/dist/compiled/picomatch` (invisible to npm audit) | bundled | prod | traced in `.next/next-server.js.nft.json`; called only by the image pattern matchers, with patterns from `next.config.js` (none set) |

The exploit needs the attacker to **supply the glob** (`+(*)`, `+(*a)`, advisory text). Every caller here gets its
patterns from our own config or tool config.
**Premise check:** "enters through `@sentry/nextjs`, which is never initialised": Sentry is 1 of 4 npm entry points
(plus Next's own copy). Removing it leaves the gate red (measured on a lockfile copy). It is imported:
`src/app/global-error.tsx:3`, `next.config.js:1` (`withSentryConfig`), `sentry.{client,server,edge}.config.ts`.

## Edge case (gate, not changed)
- `audit-gate.mjs` prints `RESOLVED … delete this allowlist entry` for minimatch, glob and uuid, yet all three
  advisories are still in `npm audit` (moderate). The gate only collects high/critical, so every moderate/low entry
  reads as resolved. elliptic is in the keeper lockfile, which this gate never audits.
