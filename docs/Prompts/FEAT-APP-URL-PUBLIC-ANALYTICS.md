# FEAT-APP-URL-PUBLIC-ANALYTICS — give the swap a real URL and make /analytics public protocol stats

> **CONTROL:** model Sonnet · effort medium · NO CI-poll (push + report, don't watch) · read ONLY the files-affected allow-list below · FEEDBACK <= 1 screen.
>
> **Source:** measured 2026-08-29. Two gaps between what the product promises and what it is: (1) "Launch app" is an in-place callback, not a URL, so `/swap` and `/app` 404; (2) `/analytics` renders wallet-scoped PersonalDashboard while `/api/stats` already serves public protocol data with zero wallet references. Fix the reality, not the promise. Landing copy belongs to the parallel agent.
>
> Display and routing only — **no Auditor gate** (no fund-flow, no signing path). SSH-signed noreply committer. Branch `feat/app-url-and-public-analytics` in a dedicated worktree under `${TS_WORKTREE_BASE:-$HOME/ts-worktrees}`. **3 droppable commits.** Exit = push + suite green + compare link + complete file-touch list; owner opens the PR. Do not watch CI.

## Requirements
1. **`/swap` is a real App Router page.** Render the existing swap experience by importing the current swap UI (`SwapBox`, `ModeTabs`, Header/Footer/shell, gated panels). Do not duplicate swap internals, do not fork those components, do not edit them. **`/app` is a permanent HTTP 308 redirect to `/swap`** (`src/app/app/route.ts`) so both addresses resolve. Leave the landing "Launch app" button exactly as it is — wiring it to push a URL is a separate PR on a file this work must not touch.
2. **`/analytics` shows the protocol to everyone.** Render the public view from `GET /api/stats` for any visitor. Show wallet-scoped `PersonalDashboard` **in addition** only when a wallet is connected. Never gate the public section behind a connection. This disconnected public-section path is the regression that matters — assert it directly.
3. **Honesty in empty and disabled states.** `/api/stats` can answer `{ enabled: false }`. When it does, or when a metric has no data yet, say so in words — **"not available yet"**, with the reason. NEVER render zeros, placeholder charts, or invented figures as if they were measurements. Small real numbers received from the API are acceptable; numbers not received from the API are not. Do not change what `/api/stats` computes — honesty is a display rule.

## Do NOT
Edit any file on the deny-list (`LandingPage.tsx`, `LandingBelowFold.tsx`, `layout.tsx`, `DocsPage.tsx`, `SwapBox.tsx`, `DCAPanel.tsx`, `README.md`, `tailwind.config.ts`, `package.json`, `vitest.config.ts`, `.github/workflows/ci.yml`, `scripts/**`). Do not edit `src/app/page.tsx`, `Header.tsx`, `sitemap.ts`, or `next.config.js`. Do not duplicate swap logic instead of importing it. Do not add analytics tracking, cookies, or any new third-party script. Do not change what `/api/stats` computes. Do not introduce a new dependency. Do not render any number not received from the API. Do not open a PR. Do not watch CI.

## Files affected (read ONLY these + new)
**New:** `src/app/swap/page.tsx` + test, `src/app/app/route.ts` + test (HTTP 308 to `/swap`), `src/lib/public-stats-display.ts` + test, `src/components/PublicProtocolStats.tsx`, `docs/Prompts/FEAT-APP-URL-PUBLIC-ANALYTICS.md`.
**Edit:** `src/app/analytics/page.tsx` + new `src/app/analytics/page.test.tsx`.
**Read-only:** `src/app/page.tsx` (compose independently; do not extract the home state machine), `src/components/SwapBox.tsx` (import only), `src/components/ModeTabs.tsx`, `src/components/Header.tsx`, `src/components/PersonalDashboard.tsx`, `src/app/api/stats/route.ts` (display its payload as-is), `src/app/page.test.tsx` (test style).

## Tests
- `/swap` renders and does not 404 (page module renders swap UI).
- `/app` issues a permanent redirect to `/swap`.
- `/analytics` renders the public section with **no wallet connected** (assert this path directly).
- `{ enabled: false }` renders the honest message and no zeroed metrics; a no-data metric says "not available yet" plus a reason.
- Connected-wallet path still shows PersonalDashboard.
- Full Vitest suite green.

## Expected output
Branch pushed. Compare link. PR body file-touch list (every file). FEEDBACK ≤ 1 screen, only if a real gap appears (`docs/feedback/feat-app-url-and-public-analytics.md`). No Auditor.
