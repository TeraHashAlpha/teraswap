# chore/next-font-local — feedback

## Checklist
- [x] C1 inventory
- [ ] C2 self-host (Inter + JetBrains Mono -> next/font/local)
- [ ] C3 guard test + CSP
- [ ] Verify offline build / suite / lint / tsc

## 1. Inventory before
Only importer of `next/font/google` in src/: `src/app/layout.tsx:2`.

| Family | subsets | weights | display | variable |
|---|---|---|---|---|
| Inter | latin | 400,500,600,700,800 | swap | `--font-inter` |
| JetBrains_Mono | latin | 400,500,600 | swap | `--font-mono` |

Both variables applied on `<html className>` in layout.tsx.
Consumers: `tailwind.config.ts:56-58` (`display` falls back to `var(--font-inter)`; `sans`=`var(--font-inter)`; `mono`=`var(--font-mono)`), `src/app/globals.css:61` (`body` font-family `var(--font-inter)`).
Not in scope (left alone): Clash Display preload from cdn.fontshare.com in layout `<head>` (runtime browser fetch, not a build-time dependency).

## Premise issue
Goal names `src/lib/security-headers.ts`; it does not exist at that path. CSP location to be resolved in C3.
