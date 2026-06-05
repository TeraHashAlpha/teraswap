# Sprint 6D — Hardening, Dashboard & UX

**Sprint window:** 2026-04-17 → TBD
**Sprint goal:** Close last LOW audit finding (FE-L-01), normalize post-incident config, deliver monitoring dashboard, and add transaction preview to swap confirmation flow.
**Owner:** TeraHash (founder/architect) + code agent
**Audit report:** `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
**Prerequisite:** Sprint 6C COMPLETE + APPROVED.

---

## Sprint status table

| # | Prompt | Finding(s) | Priority | Status |
|---|--------|-----------|----------|--------|
| 50 | Headers defense-in-depth (vercel.json sync) | FE-L-01 | LOW | ✅ `6ac3b75` |
| 51 | CoW threshold normalization | Post-incident cleanup | LOW | ✅ `a600d40` |
| 52 | Public monitoring status page | Dashboard gap (Telegram 404) | MEDIUM | ✅ `a600d40` |
| 53 | SwapConfirmModal transaction preview | UX gap + Clear Signing prep | MEDIUM | ✅ `2c93e01` — 15 tests, 3 new files, 4 modified |

---

## Prompt 50 — Headers defense-in-depth: sync vercel.json with next.config.js (FE-L-01)

**Status:** ✅ COMPLETE — `6ac3b75`.

**Context:** The comprehensive audit flagged FE-L-01 (missing CSP/HSTS headers). Investigation reveals that `next.config.js` already has a comprehensive security headers configuration (CSP, HSTS, Permissions-Policy, COOP, CORP — 9 headers total). However, `vercel.json` only has 3 basic headers (X-Frame-Options, nosniff, Referrer-Policy). On Vercel with Next.js, the `headers()` function in next.config.js covers all Next.js routes, so the headers ARE being applied. But vercel.json serves as a defense-in-depth layer — if Next.js fails to apply headers (crash, misconfiguration, edge case), vercel.json provides a fallback at the CDN/edge level.

**Objective:** Sync vercel.json headers with the existing next.config.js headers configuration to provide defense-in-depth.

**Requirements:**

1. **Add missing headers to vercel.json** — sync with what's already in next.config.js:
   ```json
   {
     "headers": [
       {
         "source": "/(.*)",
         "headers": [
           { "key": "X-Frame-Options", "value": "DENY" },
           { "key": "X-Content-Type-Options", "value": "nosniff" },
           { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
           { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
           { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
           { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
           { "key": "Cross-Origin-Resource-Policy", "value": "same-origin" },
           { "key": "X-DNS-Prefetch-Control", "value": "on" }
         ]
       }
     ]
   }
   ```

2. **Do NOT add CSP to vercel.json** — the CSP in next.config.js is dynamic (uses `process.env.NODE_ENV` for `unsafe-eval` in dev). A static CSP in vercel.json would either be too restrictive (break dev) or too permissive (include unsafe-eval in prod). Let Next.js handle CSP exclusively.

3. **Add a comment in next.config.js** above the headers section noting that vercel.json mirrors these headers as defense-in-depth (except CSP which is Next.js-only due to dynamic directives).

**Files affected:**
- `vercel.json` (add 5 missing headers)
- `next.config.js` (add comment only)

**Do NOT:**
- Do NOT add CSP to vercel.json (dynamic, Next.js-only).
- Do NOT remove any existing vercel.json configuration (buildCommand, framework, etc.).
- Do NOT change any header values — they must match next.config.js exactly.
- Do NOT change next.config.js headers logic.

**Quality criteria:**
- vercel.json has 8 headers (all from next.config.js except CSP).
- next.config.js has explanatory comment about defense-in-depth.
- `npm run build` passes.
- Verify headers don't conflict (same source pattern, no duplicates within vercel.json).

---

## Prompt 51 — CoW threshold normalization

**Status:** ✅ COMPLETE — `a600d40`.

**Context:** After the CoW Swap DNS hijack incident (INC-2026-04-14-001), cowswap thresholds were tightened to `failuresToDegraded: 2, failuresToDisabled: 3, quorumMaxDeviationPercent: 8`. The post-mortem is now complete, the source has been reactivated via `/activate cowswap confirm`, and the auditor cleared all 5 inquiry questions. The incident-driven risk no longer exists.

However, `quorumMaxDeviationPercent: 8` is justified by CoW's batch auction mechanics (prices can legitimately deviate more due to surplus capture), not by the incident. This should be kept.

**Objective:** Normalize cowswap failure thresholds back to defaults while keeping the quorum deviation override. Update the comment to reflect current rationale.

**Requirements:**

1. **Update `data/source-thresholds.json`** — cowswap overrides:
   ```json
   "cowswap": {
     "quorumMaxDeviationPercent": 8,
     "_comment": "Higher quorum tolerance due to batch auction surplus capture mechanics. Failure thresholds at defaults (post-incident heightened monitoring removed 2026-04-17, see INC-2026-04-14-001)."
   }
   ```

2. **Remove `failuresToDegraded` and `failuresToDisabled`** from the cowswap override — they revert to defaults (3/5) automatically.

3. **No code changes** — the threshold loading logic in the monitoring system reads from this JSON and falls back to defaults for missing keys. Removing the overrides is sufficient.

**Files affected:**
- `data/source-thresholds.json` (update cowswap entry)

**Do NOT:**
- Do NOT change default thresholds.
- Do NOT change any other source's overrides (1inch, 0x, teraswap-self).
- Do NOT change the threshold loading logic in code.
- Do NOT remove `quorumMaxDeviationPercent: 8` — it's justified by batch auction mechanics, not the incident.

**Quality criteria:**
- cowswap entry has only `quorumMaxDeviationPercent` and `_comment`.
- `failuresToDegraded` and `failuresToDisabled` are absent (defaults apply).
- Comment references the incident ID and date of normalization.
- `npm run build` passes.
- If threshold-related tests exist, they still pass.

---

## Prompt 52 — Public monitoring status page

**Status:** ✅ COMPLETE — `a600d40`.

**Context:** Telegram alert messages include a "Dashboard" link that currently leads to a 404 — no status page exists. Operators and stakeholders have no web-based view of source health. The monitoring data exists in Vercel KV (source states, p95 latency, uptime metrics) and the heartbeat endpoint provides health data, but there's no user-facing page.

**Objective:** Create a public `/status` page that shows real-time monitoring data for all sources.

**Requirements:**

1. **Create route `src/app/status/page.tsx`** — a server-rendered page (SSR, not static) that reads current monitoring state.

2. **Data source:** Use the existing heartbeat data. Create a new API route `src/app/api/monitor/status/route.ts` that returns the public-safe subset of monitoring data:
   ```typescript
   // GET /api/monitor/status — no auth required (public status page)
   {
     "healthy": true,
     "sources": [
       {
         "id": "1inch",
         "status": "active",        // active | degraded | disabled
         "p95LatencyMs": 1200,
         "uptimePercent": 99.8,      // last 24h
         "lastChecked": "2026-04-17T14:30:00Z"
       },
       // ... all sources
     ],
     "lastTick": "2026-04-17T14:30:00Z",
     "tickFresh": true
   }
   ```

3. **Status page UI** — clean, minimal design:
   - Header: "TeraSwap Monitor" + overall health indicator (green/yellow/red)
   - Source table: name, status badge (🟢/🟡/🔴), p95 latency, uptime %, last checked
   - Footer: last tick timestamp, auto-refresh every 60s
   - Use existing Tailwind classes. No external UI libraries.
   - Responsive (mobile-friendly — operators check on phone during incidents)
   - Dark mode support if the app already has it, otherwise light mode only

4. **Data privacy:** The status endpoint must NOT expose:
   - Internal KV keys or namespaces
   - Threshold configuration values
   - Alert history or operator actions
   - P0 reasons or lock state
   - Admin IDs or auth tokens
   Only expose: source ID, status, latency, uptime, timestamps.

5. **Source data aggregation:** Read source states from KV (`teraswap:source-state:*`). For each source:
   - `status`: derive from the state machine state (active/degraded/disabled)
   - `p95LatencyMs`: from the stored health metrics
   - `uptimePercent`: calculate from available data (or show "—" if insufficient data)
   - `lastChecked`: timestamp of last health check

6. **Error handling:** If KV is unreachable, show a "Status data temporarily unavailable" message instead of crashing. The page itself should always render.

**Files affected:**
- `src/app/api/monitor/status/route.ts` (new — public status API)
- `src/app/status/page.tsx` (new — status page)
- `src/app/status/layout.tsx` (new, if needed for metadata)

**Do NOT:**
- Do NOT require auth on the status page or API (it's public).
- Do NOT expose threshold configs, alert history, or operator actions.
- Do NOT use the admin heartbeat endpoint — create a purpose-built status API.
- Do NOT add client-side JavaScript for data fetching — use SSR with `revalidate` or client-side polling with `fetch` + `setInterval`. Prefer SSR with client-side refresh.
- Do NOT install new dependencies — use existing Next.js + Tailwind + React.

**Quality criteria:**
- `/status` renders a page showing all sources with status badges.
- `/api/monitor/status` returns JSON with source health data, no auth required.
- Page auto-refreshes every 60s.
- KV failure → graceful degradation (message, not crash).
- Mobile-responsive layout.
- Test: status API returns correct shape with mock KV data.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 53 — SwapConfirmModal transaction preview

**Status:** ✅ COMPLETE — `2c93e01`. 3 new files (calldata-decoder.ts, TransactionPreview.tsx, calldata-decoder.test.ts — 15 tests). 4 files modified (useSwap.ts, SwapBox.tsx, SwapButton.tsx, calldata-recipient.ts). New `confirming` status intercepts between simulation and wallet. CoW Protocol skips preview (EIP-712 already structured).

**Context:** The tech debt log identifies "SwapConfirmModal: no confirmation step in swap flow" as a UX gap. Users currently sign transactions without seeing decoded details of what they're approving. The calldata validation system (`src/lib/calldata-recipient.ts`) already has decoders for 19 swap selectors across all 11 DEX sources — these decoders extract recipient, amounts, and function details from calldata. This existing infrastructure can be repurposed to show a human-readable transaction preview before the user signs.

This aligns with the "clear signing" principle (Candide/Safe): no blind signing, every field visible before approval.

**Objective:** Add a transaction preview section to the swap confirmation flow that decodes and displays the transaction details before the user signs.

**Requirements:**

1. **Create `src/lib/calldata-decoder.ts`** — a utility that takes calldata + router address and returns a human-readable preview:
   ```typescript
   export interface TransactionPreview {
     sourceDex: string           // e.g., "Uniswap V3", "1inch", "ParaSwap"
     functionName: string        // e.g., "exactInputSingle", "swap", "multiSwap"
     selector: string            // e.g., "0x414bf389"
     recipient: string | null    // extracted address, or null if implicit (msg.sender)
     recipientType: 'extracted' | 'implicit' // how recipient was determined
     tokenIn?: string            // address if decodable
     tokenOut?: string           // address if decodable
     amountIn?: string           // raw value if decodable
     amountOutMin?: string       // raw value if decodable
     deadline?: number           // unix timestamp if decodable
     validated: boolean          // whether calldata passed validation
     validationReason?: string   // reason if not validated
   }
   
   export function decodeTransactionPreview(
     calldata: string,
     routerAddress: string,
     sourceName: string,
   ): TransactionPreview
   ```

2. **Reuse existing decoders** — the function should leverage the same selector matching and ABI decoding logic from `calldata-recipient.ts`. Do NOT duplicate the decoders. Import and extend where possible, or refactor shared code into helper functions both files can use.

3. **Create `src/components/TransactionPreview.tsx`** — a React component that displays the preview:
   - Source DEX name + icon (if available)
   - Function being called (human name, not just selector)
   - Recipient: show address with badge indicating "Your wallet" if it matches connected wallet, or "Router (implicit)" for trusted routers
   - Token amounts: tokenIn → tokenOut with human-readable formatting
   - Minimum output (slippage protection indicator)
   - Deadline: formatted as relative time ("expires in 20 min")
   - Validation status: green check if validated, warning if implicit/trusted
   - Collapsible "Raw calldata" section for advanced users

4. **Integrate into the swap confirmation flow** — find the existing swap confirmation modal/dialog and add the TransactionPreview component. It should appear AFTER the user clicks "Swap" and BEFORE the wallet signature request. The user sees the decoded transaction, then confirms to proceed to wallet.

5. **Graceful degradation:** If decoding fails (unknown selector, malformed data), show the raw calldata with a warning "Could not decode transaction details. Verify in your wallet." Do NOT block the swap — just warn.

**Files affected:**
- `src/lib/calldata-decoder.ts` (new — decoder utility)
- `src/components/TransactionPreview.tsx` (new — preview component)
- `src/lib/calldata-recipient.ts` (possible refactor to share decoders)
- Swap confirmation modal component (find existing, add TransactionPreview)

**Do NOT:**
- Do NOT duplicate ABI decoding logic — share with calldata-recipient.ts.
- Do NOT block swaps if decoding fails — always allow the user to proceed.
- Do NOT add external dependencies for ABI decoding — use what's already available (ethers.js or viem, whichever the project uses).
- Do NOT change the calldata validation logic (fail-closed behaviour from Prompt 46).
- Do NOT expose private keys, wallet internals, or gas estimation in the preview.

**Quality criteria:**
- TransactionPreview component renders decoded details for all major selectors (V3, 1inch, 0x, ParaSwap, Odos).
- Unknown selector → graceful fallback with raw calldata display.
- Recipient shows "Your wallet" when it matches connected address.
- Test: decodeTransactionPreview with known calldata returns correct preview.
- Test: unknown selector returns validated: false with reason.
- Component test: renders without crash for valid and invalid previews.
- `npm run build` passes. `npm run lint` clean.

---

## Auditor review — Sprint 6D

**Scope:** Review all changes from Prompts 50-53.

**Checklist:**

1. **FE-L-01 (headers defense-in-depth):**
   - [ ] vercel.json has 8 headers matching next.config.js (all except CSP)
   - [ ] CSP remains Next.js-only (dynamic unsafe-eval in dev)
   - [ ] No header value mismatches between vercel.json and next.config.js
   - [ ] No duplicate headers within vercel.json

2. **CoW threshold normalization:**
   - [ ] `failuresToDegraded` and `failuresToDisabled` removed from cowswap override
   - [ ] `quorumMaxDeviationPercent: 8` retained (batch auction justification)
   - [ ] Comment updated with normalization date and incident reference
   - [ ] Other source overrides unchanged

3. **Status page:**
   - [ ] `/api/monitor/status` returns public-safe data only (no thresholds, no alerts, no admin data)
   - [ ] `/status` page renders all sources with correct status badges
   - [ ] Auto-refresh works (60s interval)
   - [ ] KV failure → graceful message, no crash
   - [ ] Mobile-responsive

4. **Transaction preview:**
   - [ ] Decoder reuses calldata-recipient.ts logic (no duplication)
   - [ ] All major selectors produce correct preview (V3, 1inch, 0x, ParaSwap, Odos)
   - [ ] Unknown selector → warning + raw calldata (not blocked)
   - [ ] Recipient correctly identified as "Your wallet" or "Router (implicit)"
   - [ ] Component renders without crash for valid and invalid data
   - [ ] No new security surface (no private key exposure, no gas manipulation)

**Expected output:** Findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## See also

- Sprint 6C: `docs/Prompts/SPRINT-6C.md` — COMPLETE + APPROVED
- Sprint 6B: `docs/Prompts/SPRINT-6B.md` — COMPLETE + APPROVED
- Sprint 6A: `docs/Prompts/SPRINT-6A.md` — COMPLETE + APPROVED
- Comprehensive audit: `Audits/TeraSwap-Comprehensive-Audit-Post5C-2026-04-15.docx`
- CertiK AI + Clear Signing analysis: `.auto-memory/reference_certik_clearsigning.md`
- Sprint 7 (next): Forensic & post-execution security
