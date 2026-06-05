# Sprint 5C — Interactive Telegram Bot (H6) + Alert Consolidation

**Sprint window:** 2026-04-15 → 2026-04-22
**Sprint goal:** ship H6 interactive Telegram bot from ADR-001 — operator commands for monitoring status, source control, and alert management. Clean up dual alert path (I-02 tech debt from Sprint 5B).
**Owner:** TeraHash (founder/architect) + code agent
**Status as of 2026-04-15:** COMPLETE (5/5 prompts shipped, auditor approved).

---

## Sprint status table

| # | Prompt | Commit | Auditor verdict | Follow-up |
|---|---|---|---|---|
| 32 | Remove legacy alert callback (I-02 fix) + consolidate alert path | — | 🟢 APPROVED | — |
| 33 | Telegram webhook route + bot command handler | — | **1M + 3L + 1I** | Prompt 33.1 |
| 33.1 | Auditor fixes (grace KV, P0 confirm, timeout, hash, script) | `ad3f831` | All 5 fixed (177 tests) | — |
| 34 | Inline action buttons (Reactivate / Keep Disabled / Escalate) | `50dcea4` | 🟢 APPROVED (2L + 1I) | — |

---

## Architecture context

ADR-001 § H6: "Telegram bot with human-in-the-loop — receives alerts from H1/H2/H5, presents operator with action buttons [Reactivate] [Keep Disabled] [Escalate]. Primary channel Telegram, secondary Email (Resend free), tertiary Discord (private ops server)."

**Current state:** Telegram is push-only (`sendMessage` via Bot API). No webhook, no command parsing, no inline buttons. The auditor flagged I-02: `setTransitionCallback` in `monitoring-loop.ts` sends Telegram alerts directly, bypassing the alert-wrapper — creating duplicate messages per transition.

**Sprint 5C sequence:**
1. First, fix the duplicate alert path (Prompt 32) — clean foundation before adding interactivity.
2. Then, add the webhook route + command handler (Prompt 33) — bot can receive and respond to commands.
3. Finally, add inline action buttons on alerts (Prompt 34) — human-in-the-loop confirms or overrides automated decisions.

---

## Prompt 32 — Remove legacy alert callback + consolidate alert path

**Status:** Pending.

**Context:** Auditor I-02 from Sprint 5B: `monitoring-loop.ts` registers a `setTransitionCallback()` (lines 41-76) that sends Telegram alerts directly via a local `sendTelegramAlert()` function. Separately, the state machine's `transition()` function calls `emitTransitionAlert()` which fans out through the alert-wrapper to all channels (Telegram/Email/Discord) with proper dedup, grace period, and HTML escaping. Result: every state transition generates **two** Telegram messages — one raw from the callback, one properly formatted from the alert-wrapper.

**Objective:** remove the legacy direct-send path and ensure all alerts flow exclusively through `emitTransitionAlert()` in the alert-wrapper.

**Requirements:**

1. **Remove from `monitoring-loop.ts`:**
   - Delete the `initAlerts()` function entirely (lines ~41-76)
   - Delete the local `sendTelegramAlert()` function (lines ~58-76)
   - Delete the `alertInitialized` flag and the `initAlerts()` call in `runMonitoringTick()`
   - Delete the `setTransitionCallback` import if no longer used elsewhere

2. **Remove from `source-state-machine.ts`:**
   - Delete the `setTransitionCallback()` export and the `transitionCallback` variable if the only consumer was monitoring-loop.
   - Verify that `emitTransitionAlert()` is still called in `transition()` — this is the sole alert path going forward.

3. **Verify alert coverage:** After removal, confirm that ALL state transitions still produce alerts:
   - `active → degraded` ✅ via `emitTransitionAlert`
   - `degraded → disabled` ✅ via `emitTransitionAlert`
   - `disabled → active` (auto-recovery) ✅ via `emitTransitionAlert`
   - `forceDisable()` ✅ via `emitTransitionAlert`
   - `forceActivate()` — check if this emits an alert. If not, add one: `emitTransitionAlert(sourceId, 'disabled', 'active', 'manual-reactivation')`.

4. **No behaviour change** other than removing the duplicate. Alert content, formatting, dedup, and grace period remain as-is.

**Files affected:**
- `src/lib/monitoring-loop.ts` (remove ~35 lines)
- `src/lib/source-state-machine.ts` (remove callback export if unused; verify forceActivate alert)

**Do NOT:**
- Do NOT change the alert-wrapper, alert channels, or dedup logic. Only remove the duplicate path.
- Do NOT remove `emitTransitionAlert()` — that's the path we're keeping.
- Do NOT change any monitoring tick logic (H1/H2/H5 phases).

**Quality criteria:**
- All existing monitoring tests pass.
- New test: trigger a state transition, verify exactly ONE Telegram call (not two).
- `forceActivate()` emits an alert (if it didn't before, add test).
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 33 — Telegram webhook route + bot command handler

**Status:** Pending.

**Context:** The Telegram bot (`@teraswap_monitor_bot`) currently only sends alerts. To enable human-in-the-loop operations (ADR-001 § H6), the bot needs to receive and process commands. Telegram supports two modes: polling (`getUpdates`) and webhooks. Webhooks are the correct choice for a serverless environment (Vercel) — Telegram POSTs updates to our endpoint.

**Objective:** create a Next.js API route that receives Telegram webhook updates, parses bot commands, and responds with monitoring data or executes operator actions.

**Requirements:**

1. **Webhook route** — `src/app/api/telegram/webhook/route.ts`:
   - `POST` handler receiving Telegram `Update` objects
   - Auth: verify `X-Telegram-Bot-Api-Secret-Token` header matches `TELEGRAM_WEBHOOK_SECRET` env var (set via `setWebhook` API call with `secret_token` parameter)
   - Parse `update.message.text` for commands
   - Respond with 200 OK immediately (Telegram expects fast response). For commands that need async work, respond with "Processing..." first, then send result via `sendMessage`.
   - `export const dynamic = 'force-dynamic'`

2. **Commands to implement:**

   | Command | Description | Auth | Response |
   |---------|-------------|------|----------|
   | `/status` | Show all source states | Any group member | Table: source, state, last check, p95 |
   | `/status {sourceId}` | Detail for one source | Any group member | Full status: state, failure count, last 5 checks, threshold config |
   | `/quorum` | Last quorum check result | Any group member | Pairs, outliers, healthy/unhealthy |
   | `/heartbeat` | Monitoring heartbeat | Any group member | lastTick, tickCount, age, quorum status |
   | `/disable {sourceId} {reason}` | Force-disable a source | Admin only | Calls `forceDisable()`, confirms |
   | `/activate {sourceId}` | Re-activate a disabled source | Admin only | Calls `forceActivate()`, confirms |
   | `/grace {minutes}` | Set maintenance grace period | Admin only | Sets `MONITOR_GRACE_UNTIL` in KV |
   | `/help` | List commands | Any | Command reference |

3. **Admin authentication:**
   - Define `TELEGRAM_ADMIN_IDS` env var — comma-separated list of Telegram user IDs (numeric) allowed to run admin commands (disable, activate, grace).
   - Read-only commands (`/status`, `/quorum`, `/heartbeat`, `/help`) are available to any member of the group.
   - Admin commands check `update.message.from.id` against the allowlist. If not admin: respond "⛔ Admin-only command. Your ID: {id}".
   - This uses Telegram's own user identity — no shared secrets in chat.

4. **Response formatting:**
   - Use HTML parse mode (consistent with alert messages)
   - `/status` table: use `<pre>` block for alignment
   - Status emojis: 🟢 active, 🟠 degraded, 🔴 disabled
   - Timestamps in UTC ISO format
   - Truncate long responses — Telegram max message length is 4096 chars

5. **Webhook registration script** — `scripts/setup-telegram-webhook.ts`:
   - Calls `https://api.telegram.org/bot{TOKEN}/setWebhook` with:
     - `url`: `https://teraswap.app/api/telegram/webhook`
     - `secret_token`: value of `TELEGRAM_WEBHOOK_SECRET`
     - `allowed_updates`: `["message"]` (we only need text commands for now)
   - Add npm script: `"telegram:setup-webhook": "tsx scripts/setup-telegram-webhook.ts"`
   - Idempotent: running twice is safe (setWebhook replaces previous)

6. **Env vars** — add to `.env.example`:
   ```
   TELEGRAM_WEBHOOK_SECRET=     # Random string, used to verify webhook authenticity
   TELEGRAM_ADMIN_IDS=          # Comma-separated Telegram user IDs for admin commands
   ```

**Files affected:**
- `src/app/api/telegram/webhook/route.ts` (new)
- `scripts/setup-telegram-webhook.ts` (new)
- `.env.example` (add 2 vars)
- `package.json` (add script)

**Do NOT:**
- Do NOT use `getUpdates` polling. Webhooks are the correct pattern for serverless.
- Do NOT store chat state or conversation context. Commands are stateless — each command is self-contained.
- Do NOT allow `/disable` or `/activate` without admin ID verification. These are P0-equivalent operations.
- Do NOT call `forceDisable()` with a P0 reason from the bot — use `'operator-disable: {reason}'` (not P0, allows auto-recovery). If the operator wants a permanent P0 disable, they should use the kill-switch endpoint.
- Do NOT expose sensitive data in responses (no env vars, no secrets, no KV keys). Source states and timestamps are OK.

**Quality criteria:**
- Unit tests: command parsing for all 8 commands, including unknown command response.
- Test: admin command from non-admin user returns rejection with user ID.
- Test: webhook with invalid secret returns 401.
- Test: `/status` returns formatted source table.
- Test: `/disable` calls `forceDisable()` and responds with confirmation.
- Webhook registration script runs without error.
- `npm run build` passes. `npm run lint` clean.

---

## Prompt 34 — Inline action buttons on alerts

**Status:** Pending.

**Context:** ADR-001 § H6 specifies that alerts should present the operator with action buttons: `[Reactivate] [Keep Disabled] [Escalate]`. Telegram supports inline keyboards — buttons attached to messages that trigger callback queries. When a source transitions to `degraded` or `disabled`, the alert should include buttons so the operator can act without typing commands.

**Objective:** add inline keyboard buttons to alert messages and handle callback query responses.

**Requirements:**

1. **Extend alert messages with inline keyboards** (`src/lib/alert-channels/telegram.ts`):
   - When alert is for a `degraded` or `disabled` transition, attach an `inline_keyboard`:
     ```json
     {
       "inline_keyboard": [
         [
           { "text": "✅ Reactivate", "callback_data": "activate:{sourceId}" },
           { "text": "🔒 Keep Disabled", "callback_data": "keep:{sourceId}" },
           { "text": "🚨 Escalate", "callback_data": "escalate:{sourceId}" }
         ]
       ]
     }
     ```
   - When alert is for an `active` (recovery) transition, attach:
     ```json
     {
       "inline_keyboard": [
         [
           { "text": "👍 Acknowledged", "callback_data": "ack:{sourceId}" }
         ]
       ]
     }
     ```
   - `callback_data` max 64 bytes — the `action:sourceId` format fits easily.

2. **Handle callback queries** in webhook route (`src/app/api/telegram/webhook/route.ts`):
   - Parse `update.callback_query` in addition to `update.message`
   - Extract action and sourceId from `callback_data`
   - Actions:
     - `activate:{sourceId}` → admin-only, calls `forceActivate(sourceId)`, answer callback with "✅ {sourceId} reactivated"
     - `keep:{sourceId}` → admin-only, no state change, answer with "🔒 {sourceId} kept disabled — noted", log to KV audit trail
     - `escalate:{sourceId}` → admin-only, sends a high-priority re-alert to ALL channels (bypass grace + dedup), answer with "🚨 Escalated — all channels notified"
     - `ack:{sourceId}` → any member, answer with "👍 Acknowledged by {username}", no state change
   - Always call `answerCallbackQuery()` to dismiss the loading spinner on the button
   - After action, edit the original message to append "— Action: {action} by {username} at {time}" (use `editMessageText` to update inline with result)

3. **Admin check for button actions:**
   - `activate`, `keep`, `escalate` require `callback_query.from.id` to be in `TELEGRAM_ADMIN_IDS`
   - If not admin: `answerCallbackQuery({ text: "⛔ Admin only", show_alert: true })`
   - `ack` is available to any group member

4. **Audit trail:**
   - All button actions (including `ack`) logged to KV: `teraswap:telegram:action:{timestamp}` with `{ action, sourceId, userId, username, timestamp }`
   - No TTL — permanent audit trail

5. **Graceful handling:**
   - If `sourceId` no longer exists in KV (source removed), respond "Source not found"
   - If source is already in the target state (e.g., activate on already-active), respond "Already active — no change"
   - If callback_data format is invalid, ignore silently (old messages with stale buttons)

**Files affected:**
- `src/lib/alert-channels/telegram.ts` (add inline_keyboard to sendMessage payload)
- `src/app/api/telegram/webhook/route.ts` (add callback_query handler)

**Do NOT:**
- Do NOT use `forceDisable()` with P0 reason from buttons. The `keep` action doesn't change state — it's an acknowledgement, not an escalation.
- Do NOT remove buttons after action — edit the message text to show what happened but keep the message visible for audit.
- Do NOT allow button actions on messages older than 48h (Telegram's limitation on editMessageText). If edit fails, send a new message instead.
- Do NOT add buttons to email or Discord alerts. Inline keyboards are Telegram-specific. Email/Discord remain push-only.

**Quality criteria:**
- Unit tests: callback_query parsing for all 4 actions.
- Test: admin button action from non-admin returns rejection.
- Test: activate button calls forceActivate and edits message.
- Test: escalate button triggers alert to all channels (bypass dedup).
- Test: ack button works for any group member.
- Test: stale/invalid callback_data handled gracefully.
- Alert messages include inline keyboard (verify payload structure).
- `npm run build` passes. `npm run lint` clean.

---

## Auditor review — Prompt 32

**Scope:** review changes to `src/lib/monitoring-loop.ts` and `src/lib/source-state-machine.ts`.

**Checklist:**
1. Legacy `setTransitionCallback` and direct `sendTelegramAlert` completely removed
2. No orphaned imports or dead code left behind
3. All state transitions still produce exactly one alert via `emitTransitionAlert()`
4. `forceActivate()` emits an alert (new or pre-existing)
5. No regression in H1/H2/H5 monitoring loop phases
6. All existing tests pass
7. Test confirms single Telegram call per transition (not two)

**Expected output:** findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## Auditor review — Prompt 33

**Scope:** review `src/app/api/telegram/webhook/route.ts`, `scripts/setup-telegram-webhook.ts`, env var additions.

**Checklist:**
1. Webhook secret verified via constant-time comparison (not `===`)
2. Admin ID check is numeric comparison (not string — Telegram IDs are integers)
3. `/disable` uses non-P0 reason (`operator-disable:`) — NOT a P0 bypass
4. `/activate` calls `forceActivate()` correctly and emits alert
5. `/grace` sets KV value with correct ISO format and TTL
6. No sensitive data in bot responses (no env vars, secrets, KV keys)
7. Command parsing handles edge cases: empty args, extra spaces, unknown commands
8. Webhook registration script is idempotent and uses correct Telegram API
9. Response truncation at 4096 chars
10. All commands tested including auth rejection

**Expected output:** findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## Auditor review — Prompt 34

**Scope:** review changes to `src/lib/alert-channels/telegram.ts` and `src/app/api/telegram/webhook/route.ts`.

**Checklist:**
1. `callback_data` format is parseable and stays under 64 bytes
2. Admin-only actions (`activate`, `keep`, `escalate`) check `from.id` against allowlist
3. `answerCallbackQuery` always called (prevents hanging spinner)
4. `editMessageText` failure handled gracefully (falls back to new message)
5. `escalate` bypasses both grace period and dedup (correct for emergency)
6. Audit trail entries are permanent (no TTL)
7. `ack` action available to non-admins (correct — it's an acknowledgement, not an operation)
8. Stale callback_data (unknown sourceId or invalid format) handled without crash
9. No P0 reason used from button actions
10. Inline keyboard only attached to Telegram alerts (not email/discord)

**Expected output:** findings table. Verdict: APPROVED / APPROVED WITH WARNINGS / NEEDS REVISION.

---

## Post-sprint: webhook setup (manual, TeraHash)

After Prompt 33 is deployed, TeraHash must run:

```bash
# Set the env vars on Vercel first:
# TELEGRAM_WEBHOOK_SECRET = (openssl rand -base64 32)
# TELEGRAM_ADMIN_IDS = (your Telegram user ID — get via /help command or @userinfobot)

# Then register the webhook:
npm run telegram:setup-webhook
```

This is a one-time setup. The webhook persists until explicitly removed.

---

## See also

- ADR-001 § H6 — the decision behind interactive Telegram bot
- Sprint 5B `docs/Prompts/SPRINT-5B.md` — prerequisite: H5 quorum (complete)
- Sprint 5A `docs/Prompts/SPRINT-5A.md` — prerequisite: alerts + kill-switch (complete)
- Telegram Bot API docs: https://core.telegram.org/bots/api
- Telegram inline keyboards: https://core.telegram.org/bots/api#inlinekeyboardbutton
