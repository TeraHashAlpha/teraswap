# SEC-4 · Wave 9 — Wallet / frontend / session (A3 + UX-safety) — entry packet

> **Campaign:** 2026-07-01. **Sprint:** SEC-4 (parallel after W0). **Runner:** Auditor (read-only). **Baseline:**
> `origin/main` (cb0748d) per plan §0 — read via `git show origin/main:<path>`. **Grounded on:** W0-recon.md §2 +
> W2 (min-output/recipient) + W5 (review-gate/frozen payload). **Source of truth:** T-SAF v1 §5-W9 + §6 INV-1/6 +
> §9 G3. **Binding:** T-SAF §1 + CLAUDE.md #1/#2/#3/#12 (+ ADR-008 no wagmi-v3).

## Objective
Prove the wallet/session layer is robust (single WC core, clean lifecycle), secure storage is Web-Crypto (no
plaintext), min-output/slippage are enforced **client AND server**, the review modal shows the **true frozen
payload** (W5), and no user-controlled string can XSS into the DOM / an alert.

## In-scope (W0 §2.8)
wagmi/RainbowKit/WalletConnect wiring, `WalletSessionGuard`, COOP/COEP headers, secure storage (Web Crypto,
FE-01/#39), SwapBox / simulation / slippage / min-output UI, token catalog (#249 verified-badge), review modals;
ADR-008.

## Attacker goal (A3; §5-W9, §9-G3)
Hijack a WC session; downgrade slippage/min-output client-side; render a misleading review; leak session/secrets via
storage; XSS a token symbol / oracle-less note into an alert/label.

## Must-verify invariants (INV-1/6; negative-path first)
1. **Single `@walletconnect/core`, pinned `qr`;** session lifecycle sound — idle disconnect, **no double-init**
   (the historical 4-Cores/premature-wagmi-v3 bug is closed), clean teardown. No wagmi-v3 (ADR-008).
2. **COOP/COEP set** (cross-origin isolation) — confirm headers on the app responses (ties W10).
3. **Secure storage = Web Crypto (AES-256-GCM, FE-01)** — no plaintext secrets/keys in localStorage/sessionStorage.
4. **Min-output / slippage enforced client AND server:** a client-side downgrade to ~0 does not settle — the server
   (W2 `amountOutMin` floor) + on-chain `minimumOutput` still bind (G3.2). Slippage bounded (0–15, W6).
5. **Review modal = the true frozen payload** (W5): the SwapBox/order review shows exactly what will be signed/sent;
   no last-moment rebuild.
6. **XSS: user-controlled strings escaped** — token symbols/names (from the #249 catalog + manual imports), the
   oracle-less note (#18), any address label → rendered as escaped JSX text, never `dangerouslySetInnerHTML`; nothing
   flows unescaped into a Telegram message or the DOM.

## Method & tools (§7.5)
Dependency **de-dup check** (`npm ls @walletconnect/core` etc. — reconcile with W10); session **state-machine
review** (init/connect/idle/disconnect/teardown); **render-path review** for injection (grep
`dangerouslySetInnerHTML`, trace token-symbol/user-string sinks); reconcile **slippage/min-output client vs server**
(the client value can only tighten, never loosen past the server/on-chain floor); confirm COOP/COEP + secure-storage
crypto path.

## Negative-path battery (each must be refused/safe)
Double WC init / stale session · client slippage downgraded to ~0 (must still be bound by server + on-chain) ·
a token symbol containing `<script>`/HTML (must render escaped) · plaintext secret in storage · review modal that
diverges from the signed payload.

## Exit criteria
Single WC core + clean session; storage Web-Crypto; min-output/slippage enforced both sides; review modal truthful;
all user strings escaped (no XSS). Findings → §4 evidence bundle → remediation prompts (RICE).

---

### `/goal` paste for the Auditor (≤4000)
```
Wave 9 (Wallet/frontend/session — A3) per Audits/Campaign/2026-07-01/
W9-frontend-session.md + TERASWAP-AUDIT-FRAMEWORK.md §5-W9. READ-ONLY, no code
edits. Baseline origin/main (cb0748d) — read via `git show origin/main:<path>`;
record the audited SHA. Ground on W2 (min-output/recipient) + W5 (frozen
payload). Binding incl. ADR-008 (no wagmi-v3).

Scope: wagmi/RainbowKit/WalletConnect, WalletSessionGuard, COOP/COEP, secure
storage (Web Crypto FE-01), SwapBox/simulation/slippage/min-output UI, token
catalog (#249), review modals, ADR-008.

Prove (negative-path FIRST — each must be refused/safe):
1. Single @walletconnect/core, pinned qr; session lifecycle sound (idle
   disconnect, NO double-init — the 4-Cores/premature-wagmi-v3 bug closed,
   clean teardown); no wagmi-v3.
2. COOP/COEP headers set (cross-origin isolation).
3. Secure storage = Web Crypto AES-256-GCM (FE-01) — no plaintext secrets/keys
   in local/sessionStorage.
4. Min-output/slippage enforced CLIENT AND SERVER: a client downgrade to ~0 does
   NOT settle (server amountOutMin floor + on-chain minimumOutput still bind);
   slippage bounded 0-15.
5. Review modal = the true frozen payload (SwapBox/order review shows exactly
   what's signed/sent; no last-moment rebuild).
6. XSS: user strings (token symbols/names from #249 + imports, the oracle-less
   note #18, address labels) render as ESCAPED JSX; no dangerouslySetInnerHTML;
   nothing unescaped into a Telegram message or the DOM.

Tools: npm ls @walletconnect/core (dedup, reconcile w/ W10); session
state-machine review; grep dangerouslySetInnerHTML + trace user-string sinks;
reconcile slippage/min-output client vs server (client can only tighten); COOP/
COEP + secure-storage crypto path.

Deliver into Audits/Campaign/2026-07-01/W9-frontend-session.md (report section):
audited SHA, checks table, findings (Sev·file:line·disposition + §4 evidence
bundle), negative-path results, coverage fraction, verdict (0C/0H bar),
remediation-prompt list. SSH-signed commit left for owner if no key in sandbox.
```

---

# WAVE 9 — REPORT (executed 2026-07-01, Auditor, read-only)

**Audited SHA (production):** `origin/main` = **`cb0748de466c50c1749dfea53ad5c0424f6c0bf6`** (reads via
`git show origin/main:<path>`; working tree `df00d35` ignored per W3-H-01).

## Verdict: APPROVED — 0C / 0H / 0M / 1L / 2I
Single `@walletconnect/core`, pinned `qr`, wagmi **v2** (ADR-008 held); session lifecycle test-locked; no
`dangerouslySetInnerHTML` and all user strings render React-escaped; secure storage is AES-256-GCM;
min-output/slippage bind client **and** server **and** on-chain. One LOW (secure-storage plaintext fallback
when the wallet key isn't derived) — FE-hardening, no key/seed material at risk.

## Checks-run (negative-path first)
| # | Check | Result |
|---|-------|--------|
| 1 | Single WC core / pinned qr / no wagmi-v3; session sound | ✅ Lockfile resolves **one** `@walletconnect/core@2.21.1` (overrides-pinned, + sign-client/universal-provider 2.21.1); `qr@0.5.5` (the 0.6.0 crash pin); **wagmi 2.19.5 (v2)** — ADR-008 held. Single `wagmiConfig.ts` (no double-init); the 4-Cores/premature-v3 bug is closed by the single-core dedup. `WalletSessionGuard` idle-disconnect (1h) + no-premature-disconnect on fresh-connect/visibility-change is **test-locked** (9Z `WalletSessionGuard.test.tsx`). |
| 2 | COOP/COEP headers | ✅ `Cross-Origin-Opener-Policy: same-origin-allow-popups` (correct for wallet popups, 9N), `Cross-Origin-Resource-Policy: same-origin`, CSP, HSTS, X-Frame-Options (`next.config.js` + mirrored in `vercel.json`). COEP intentionally omitted (require-corp breaks wallet embeds) → W9-I-01. |
| 3 | Secure storage = Web Crypto AES-256-GCM (FE-01) | ✅ `secure-storage.ts` (P199): PBKDF2(SHA-256)→AES-GCM-256 key **derived from the wallet address** (per-wallet); stores `{v,iv,ct}` (base64 ciphertext); order/trade metadata only — **never keys/seeds**. Plain-localStorage elsewhere holds only non-sensitive prefs/IDs (dismissed orders, notif prefs, source prefs, session id). ⚠ plaintext fallback when the key is unavailable → W9-L-01. |
| 4 | Min-output/slippage client AND server AND on-chain | ✅ Server bounds slippage `0–15` (`route.ts:176`, 400 otherwise); a client downgrade can only **tighten**. A client `minimumOutput→0` (W2-L-01 edge) is still caught by the server DefiLlama **−8%** guard (422) + the router's own `amountOutMin` + (when set) the on-chain FeeCollector `minimumOutput` (W2). A ~0 downgrade **cannot settle a bad-price fill**. |
| 5 | Review modal = true frozen payload | ✅ (W5) `confirmSwap` sends the frozen `pendingSwap` (no last-moment rebuild); CoW signs the exact frozen payload; order create signs the frozen struct under `getOrderExecutorDomain(chainId)`. |
| 6 | XSS: user strings escaped; no raw HTML sink | ✅ **No `dangerouslySetInnerHTML`** in `src` (only a comment noting its absence). Token symbols/names (#249 catalog), custom imports, the oracle-less note, and address labels render via React `{expr}` → escaped. `SwapBox.tsx:1049` `window.open` targets a **fixed** `twitter.com/intent/tweet` base with `encodeURIComponent(shareText)` + `noopener,noreferrer` (no injection, no reverse-tabnabbing). `logoURI` is used only as `<img src>` (a `javascript:` URI does not execute there). Telegram alert strings are `esc()`-escaped server-side (W8). |

## Findings
| ID | Sev | file:line | Disposition | Evidence |
|----|-----|-----------|-------------|----------|
| W9-L-01 | LOW (privacy/FE) | `src/lib/secure-storage.ts:184-188` | REMEDIATION-PROMPT | When the wallet-derived key is unavailable (`!cryptoKey` — SubtleCrypto absent, or a write **before** key derivation / wallet connect), the module **falls back to plaintext** `localStorage.setItem(key, json)` (warned). In prod (HTTPS secure-context + connected wallet) it shouldn't fire, but a pre-connect/race write of order/trade metadata would be plaintext (readable by an XSS payload or a browser extension). **No key/seed material is ever stored** (fund-safe). Fix: buffer/refuse sensitive writes until the key is derived, or gate callers to `await` init; keep the fallback only for genuinely non-sensitive values. |
| W9-I-01 | INFO | `next.config.js` headers | REPORT | COEP (`require-corp`) is intentionally **not** set — it would break WalletConnect / wallet-provider embeds. The app relies on COOP (`same-origin-allow-popups`) + CSP + CORP. Correct posture for a dApp; recorded so "COOP/COEP" isn't misread as a gap. |
| W9-I-02 | INFO | `useSwap.ts` (W2-L-01 cross-ref) | REPORT | The client-downgrade edge (minOut=0 on a malformed `toAmount`) is compensated by the server DefiLlama −8% guard + router `amountOutMin`; a bad-price fill still can't settle. Tracked as W2-L-01. |

## Negative-path battery (each refused/safe)
Duplicate WC core / wagmi-v3 → lockfile pins single core + wagmi v2 ✅ · session double-init / premature
disconnect → single config + 9Z-test-locked guard ✅ · sensitive value in plaintext localStorage →
AES-256-GCM (except the key-unavailable fallback, W9-L-01) ✅ · client slippage > 15 → server 400 ✅ · client
minOut → 0 → DefiLlama −8% + router amountOutMin bind (no bad-price settle) ✅ · last-moment payload rebuild
before sign → frozen-then-sign (W5) ✅ · XSS via token symbol/import/label → React-escaped, no raw sink ✅ ·
`window.open(userString)` → fixed twitter base + encodeURIComponent + noopener ✅.

## Coverage (frontend/session slice)
- Reviewed on `main`: `package.json`/lockfile (WC/qr/wagmi/rainbowkit), `next.config.js` (headers),
  `secure-storage.ts`, `WalletSessionGuard.tsx` (+9Z tests), `wagmiConfig.ts`/`providers.tsx`, `SwapBox.tsx`
  (window.open + slippage), `useSwap.ts` (min-output, review — W2/W5), token rendering (#249).
- Not run in-sandbox: `npm ls` (used the lockfile directly), a live browser XSS/session harness, real-device
  WalletConnect mobile lifecycle (human-only) — reasoned from the single-core dedup + the 9Z test suite.

## Remediation prompts
1. **W9-L-01 — remove the secure-storage plaintext fallback for sensitive values.** In `secure-storage.ts`,
   when `!cryptoKey`, **do not** write sensitive order/trade metadata as plaintext — buffer until key
   derivation completes, or drop the write (and surface the `NO_CRYPTO_WARNING`). Keep plaintext only for
   explicitly non-sensitive keys. Add a test: a write issued before key init is not persisted in plaintext.
   Frontend-only; no contract/gate change.

## Boundaries
Read-only on `origin/main`; no live browser/session/real-device runs (human-only). W10 (supply-chain/CI)
consumes: the WC/qr/wagmi pins live in the lockfile+overrides (verify single-instance in CI); headers are
mirrored in `vercel.json`. W11 synthesizes.
