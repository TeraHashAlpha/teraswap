# CHORE-SUSHI-V7-REDSNWAPPER-QUOTE-FIX — restore Sushi v7 quotes (both chains); scope execution safely per chain

> **Source:** T-SAF W7-followup silent-sources investigation (PR #258, 2026-07-02). Sushi v7 now settles via the
> **RedSnwapper** router on both chains; the adapter's quote request sends a wrong/missing **`sender`** param → the
> API returns no route, so Sushi has been silent (0 quotes in 18/18 samples). A one-param fix restores QUOTES
> everywhere. BUT mainnet FeeCollector/OrderExecutor do **not** whitelist RedSnwapper → a mainnet Sushi route hits
> SC-04 `isKnownSwapSelector` fail-closed and falls back (SAFE — no fund risk — but a UX papercut if it wins the
> display). **No on-chain tx, no contract change, and no new SC-04 / recipient-decoder entry without the fund-flow
> gate.** SSH-signed (noreply committer).

## Context
- Sushi migrated quoting/settlement to **RedSnwapper** (v7). The adapter's quote call sets the `sender` param wrong
  (or omits it) → RedSnwapper returns no route → Sushi silent in prod.
- **Mainnet** FC/OE do **not** whitelist RedSnwapper → a Sushi/mainnet fill can't settle (SC-04 → 9O fallback). The
  investigation says execution is intended **Base-only** until a contract-gated mainnet whitelist tx.

## Objective
Restore Sushi v7 quotes on both chains with the `sender` fix, and scope Sushi's **executability by chain** to exactly
where RedSnwapper is fully wired (SC-04 selector + recipient decoder + on-chain FC/OE whitelist) — quote-only
elsewhere — so no user is shown a Sushi winner that can't settle. Do not touch fund flow.

## Requirements
1. **Quote fix (the low-risk core):** correct the `sender` param the Sushi v7 / RedSnwapper quote endpoint requires
   (verify the expected value against Sushi's API — likely the account that initiates the swap: the FeeCollector/
   executor or the user, per their contract). After the fix, Sushi returns a route for a canonical pair on **both**
   chains. Add a test asserting a non-empty Sushi route for one pair per chain.
2. **Verify the RedSnwapper EXECUTION chain per chain (report a matrix — fund-flow-adjacent, be exact):**
   - (a) is RedSnwapper's swap selector in the SC-04 `isKnownSwapSelector` allowlist?
   - (b) does `validateCallDataRecipient` (R1) have a decoder that extracts + verifies the recipient from RedSnwapper
     calldata (recipient = user / FeeCollector)?
   - (c) is RedSnwapper in the on-chain FC/OE `whitelistedRouters` (read-only view call), per chain?
   Produce a Base-vs-mainnet table of (a)/(b)/(c).
3. **Scope executability by that matrix (router-allowlist parity, W4):** Sushi-v7 is presented as **executable** on a
   chain **only if all of (a)(b)(c) hold**; otherwise it is **quote-only** on that chain (must not win the executable
   path; label as informational) — and SC-04 fail-closed remains the terminal backstop regardless.
4. **Branch on the verification result:**
   - If **Base is fully wired** (a∧b∧c) and mainnet lacks only (c) → ship the quote fix + scope mainnet Sushi as
     **quote-only**, and write a follow-up note: *mainnet Sushi execution needs a contract-gated RedSnwapper whitelist
     tx* (rules #2/#3) — do NOT do it here; flag for the proper gate + Auditor.
   - If RedSnwapper is **not** execution-wired on either chain (no SC-04 entry / no recipient decoder = a genuinely new
     router) → **STOP at quote-only on both chains** and flag that executable support (recipient decoder + SC-04 entry
     + on-chain whitelist) is a **separate fund-flow task requiring an Auditor re-pass** (same class as the W7-L-02
     decoders) — do NOT build it in this PR.

## Do NOT
- No on-chain transaction, no `whitelistedRouters` change, no contract change.
- Do **not** add RedSnwapper's selector to SC-04 or add/modify a recipient decoder **without** the fund-flow
  verification + (if it's new) an Auditor re-pass — that is a gated change (rules #2/#3), not part of a quote fix.
- Do **not** let a non-settleable Sushi quote win the executable path on any chain.

## Files affected (verify on main)
- The Sushi adapter (v7 / RedSnwapper quote request — the `sender` param) + its test.
- The router-allowlist / executable-source scoping (W4 parity) for per-chain gating.
- Read-only: SC-04 `isKnownSwapSelector`, `validateCallDataRecipient` decoders, the on-chain FC/OE whitelist (matrix).

## Expected output
- Branch `chore/sushi-v7-redsnwapper-quote-fix` off latest `origin/main`; SSH-signed; CI green. Sushi returns quotes on
  both chains; the (a)(b)(c) matrix is in FEEDBACK; Sushi executable only where fully wired, quote-only elsewhere; the
  mainnet whitelist need filed as a contract-gated follow-up (not done here). Tests: Sushi route non-empty per chain; a
  mainnet Sushi win does not present as executable (or fail-closes to fallback).

## Quality criteria
Sushi v7 quotes on both chains; no user sees a Sushi winner that can't settle; zero on-chain / contract / SC-04 /
decoder change without the gate; the mainnet RedSnwapper whitelist filed as a contract-gated + Auditor task; the
per-chain execution matrix is explicit.

---

### `/goal` paste for the Code Agent (≤4000)
```
CHORE-SUSHI-V7-REDSNWAPPER-QUOTE-FIX per docs/Prompts/CHORE-SUSHI-V7-REDSNWAPPER-
QUOTE-FIX.md. Branch off origin/main, SSH-signed (noreply committer), CI green.
No on-chain tx, no contract change, and NO new SC-04 / recipient-decoder entry
without the fund-flow gate.

Context (T-SAF W7-followup, PR #258): Sushi v7 now settles via the RedSnwapper
router on both chains; the adapter's quote request sends a wrong/missing `sender`
param -> RedSnwapper returns no route -> Sushi silent (0 quotes in prod). Mainnet
FC/OE do NOT whitelist RedSnwapper, so a mainnet Sushi fill can't settle (SC-04 ->
9O fallback; safe, but a UX papercut if it wins the display). Execution intended
Base-only until a contract-gated mainnet whitelist tx.

Do:
1. QUOTE FIX (core): correct the `sender` param the Sushi v7/RedSnwapper quote
   endpoint needs (verify the expected value vs Sushi's API — the account
   initiating the swap: FeeCollector/executor or user). After fix, Sushi returns a
   route for a canonical pair on BOTH chains. Test: non-empty Sushi route per chain.
2. VERIFY the RedSnwapper execution chain per chain (report a Base-vs-mainnet
   matrix; fund-flow-adjacent, be exact): (a) RedSnwapper selector in SC-04
   isKnownSwapSelector? (b) validateCallDataRecipient (R1) has a decoder that
   verifies recipient=user/FeeCollector from RedSnwapper calldata? (c) RedSnwapper
   in the on-chain FC/OE whitelistedRouters (read-only view call)?
3. SCOPE executability by that matrix (W4 parity): Sushi-v7 executable on a chain
   ONLY if (a)&&(b)&&(c); else quote-only on that chain (must not win the
   executable path; label informational). SC-04 fail-closed stays the backstop.
4. BRANCH on the result:
   - Base fully wired (a&&b&&c) and mainnet lacks only (c) -> ship quote fix +
     scope mainnet Sushi quote-only + file a follow-up: mainnet Sushi execution
     needs a CONTRACT-GATED RedSnwapper whitelist tx (rules #2/#3) — do NOT do it
     here; flag for the gate + Auditor.
   - RedSnwapper NOT execution-wired anywhere (no SC-04 entry / no decoder = new
     router) -> STOP at quote-only on both chains + flag executable support
     (decoder + SC-04 + on-chain whitelist) as a separate fund-flow task needing an
     Auditor re-pass (W7-L-02-decoder class) — do NOT build it here.

Do NOT: on-chain tx / whitelist / contract change; add RedSnwapper to SC-04 or
add/modify a recipient decoder without the fund-flow gate + Auditor re-pass; let a
non-settleable Sushi quote win the executable path.

Files (verify on main): the Sushi adapter (v7 sender param) + test; the router-
allowlist/executable-source scoping (W4) for per-chain gating; read-only SC-04,
validateCallDataRecipient, on-chain FC/OE whitelist for the matrix. FEEDBACK: the
(a)(b)(c) per-chain matrix + which branch was taken.
```
