# CHORE-DCA-CUSTOM-PERIODS

> **NOTE:** This spec file did not exist in the repository, git history, or `origin/main` at
> implementation time. Reconstructed verbatim from the `/goal` command text (the Architect's
> full spec), with explicit user confirmation to proceed on that basis. Committed here per the
> "commit spec with PR" process convention.

NO CI-poll (push + report, don't watch) ·
read ONLY the DCA files listed · FEEDBACK <= 1 screen.

CHORE-DCA-CUSTOM-PERIODS per docs/Prompts/CHORE-DCA-CUSTOM-PERIODS.md. Branch
chore/dca-custom-periods off origin/main, SSH-signed. DCA is Base-only. Frontend +
order-creation validation — no contract/keeper/gate change -> no Auditor.

Feature: add a Custom option to DCA — interval = a number 1-10 x {hours|days};
number of buys = 1-100 (keep the presets as default).

Do:
1. Custom UI in DCAPanel: a "Custom" toggle -> buys 1-100 (clamped) + interval
   1-10 with an hours/days unit toggle (clamped).
2. Guardrails (bounds alone don't cover these):
   - Min-chunk USD (dust/SC-02): each buy >= DCA_MIN_CHUNK_USD (env); if buys*min >
     total, cap the buys or warn ("com N compras cada uma e $X < minimo"). No dust
     order.
   - Expiry coherence: interval*buys can reach 1000 days but preset expiry maxes at
     90d. AUTO-DERIVE expiry = interval*buys + buffer when Custom is used (or, if
     expiry stays a field, HARD-WARN when expiry < interval*buys).
   - Live non-alarmist summary: "N compras de $X a cada Y, termina ~Z."
3. Verify (read-only) the OrderExecutor DCA param bounds + keeper interval limits
   BEFORE allowing custom values; clamp custom ranges to them — the UI must not let
   the user sign an order the contract/keeper would reject.
4. Sign the correct params via the existing DCA signing path; the on-chain
   execution + the Phase-0 floor (#279) apply unchanged.

Do NOT: contract/keeper/execution-gate change; allow values outside the bounds or
the on-chain/keeper limits; let a dust or expires-before-completing order through;
touch the preset path beyond the toggle.

Files (read ONLY these): DCAPanel.tsx; the DCA order-creation/signing path
(useOrderEngine / DCA params); a min-chunk/expiry helper; read-only the
OrderExecutor DCA bounds + keeper interval limits; + tests. Tests: buys/interval
clamp; dust order capped/blocked; incoherent expiry auto-derives/hard-warns; signed
params within contract/keeper bounds. FEEDBACK: min-chunk USD + buffer + the bounds
found.
