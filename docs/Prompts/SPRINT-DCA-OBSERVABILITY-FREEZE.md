# SPRINT-DCA-OBSERVABILITY-FREEZE — executor alerts, 0-20 freeze-urgency score, manual user-safe freeze

Add production observability + an advisory circuit-breaker for the live Base keeper before DCA go-live. The
bot is **advisory only — it NEVER auto-freezes**; it alerts (Telegram) and computes a **0-20 freeze-urgency
score** so the owner decides. A **manual, user-safe freeze** mechanism is provided (off-chain; on-chain
`pause()` stays the admin nuclear option). Branch `sprint/dca-observability-freeze` off latest `origin/main`.
CI + test-contracts green; SSH-signed commits; FEEDBACK. **Flag for Auditor** (freeze touches order execution
— the user-safety invariant must be verified).

## Part A — Telegram alerts (in `executor.js`, replacing the "Telegram not configured" stub)
Env: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (owner supplies later; if unset, log-only, no crash). Events:
1. **🆕 New DCA position** (info): when the keeper first sees a new DCA order in Supabase — token in→out,
   **quantity** (amountIn, human-readable), **duration** (dcaInterval × dcaTotal), **parts** (dcaTotal),
   per-chunk amount.
2. **⛽ Low gas** (warning): executor wallet (`0x71f5…Aa2E5`) ETH balance × ETH-USD < **$5**.
3. **🚨 Unexplained ETH outflow** (critical — possible key/wallet compromise): each cycle, track the wallet's
   ETH balance delta and subtract the gas the executor itself spent on its own txs that cycle. If
   `unexplained_outflow > threshold` (configurable; default a small ETH amount) → critical alert. (The key is
   in KMS/HSM, so ANY outflow that isn't the executor's own executeOrder gas is anomalous.)
4. **⚙️ Operational**: process crash/restart, RPC unreachable, execution failure(s), stale-lock recovery.

## Part B — Freeze-urgency score (0-20), advisory
- Compute a continuous **0-20** score aggregating weighted risk signals (tune as constants, document them):
  unexplained-ETH-outflow (dominant, up to ~12), low/critical gas (~4), repeated execution failures (~4),
  RPC/connectivity (~3), other anomalies (small). Cap 0-20.
- Include the **current score** in every alert. Escalate the alert tone at thresholds (e.g. ≥8 "consider
  freezing", ≥15 "strongly consider freezing now"). **Never freezes by itself** — purely informational so the
  owner can decide.

## Part C — Manual, user-safe freeze mechanism (owner-triggered)
- **Shared flag** in Supabase (e.g. `system_state`/`circuit_breaker`: `dca_frozen` bool + `reason` + `at`).
- **Keeper** reads it each cycle → if frozen, **skips DCA execution** (and alerts once).
- **API** (`api/orders` create) reads it → **rejects NEW DCA creation** while frozen with a friendly message.
- **USER-SAFETY INVARIANT (must hold + be tested):** freezing does NOT cancel/modify existing orders, does NOT
  touch funds, does NOT change approvals. Users can still cancel orders + revoke approvals while frozen. On
  unfreeze, pending DCAs resume on schedule (the contract's cumulative tracking means a delayed chunk is not
  lost). **Freeze = delay, never loss.**
- **Owner control to set/clear the flag:** an **admin-authenticated** path (reuse the existing `/admin` /
  admin-API auth — the admin wallet `0x9A38`), NOT the keeper. Document the on-chain `pause()`/`unpause()`
  (admin, cast) as the nuclear escalation for severe cases.
- (Optional, note as follow-up if heavy) a Telegram `/freeze` command listener — otherwise the alert text
  tells the owner exactly how to freeze.

## Do NOT
- **No auto-freeze** — the bot never sets the freeze flag itself. No contract/Solidity changes. No change to
  execution correctness or the swap/gate paths; mainnet byte-identical. Keys stay server-side/KMS.
- Don't break the keeper's existing loop; alerting/score must be non-blocking (failures to send an alert must
  not stop execution).

## Output
- Branch `sprint/dca-observability-freeze`; alerts + score in the executor, freeze flag honored by keeper +
  API, admin control to toggle it, tests (incl. the user-safety invariant: frozen ⇒ no order/fund/approval
  change, pending resumes after unfreeze). FEEDBACK with the score weights + thresholds + the freeze-trigger
  surface. **Auditor review required** before merge (user-safety of the freeze).
