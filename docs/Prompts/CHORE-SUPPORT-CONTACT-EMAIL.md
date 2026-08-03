# CHORE-SUPPORT-CONTACT-EMAIL — surface a public support email across the app (single source of truth)

## Context
Users need a way to ask questions / get support. Add a **public support email** across the app's contact
touchpoints, driven by a **single source-of-truth constant** so it's one line to change.

**⚠️ Security:** the value MUST be a PUBLIC support address (e.g. `support@teraswap.app`), set by the owner —
**NOT** the team's recovery-root ops email. Exposing the recovery-root address publicly enables phishing /
account-recovery targeting of the whole infra. The owner fills the constant's value; leave a clear placeholder
+ a comment warning against using the recovery email.

## Requirements
1. **Single constant:** define `SUPPORT_EMAIL = "support_teraswap@proton.me"` once (a config/constants file)
   with a comment: "PUBLIC support address only — never the recovery-root ops email." Every reference uses this
   constant (no scattered hardcoded emails). (This is the dedicated PUBLIC support inbox, distinct from the
   recovery-root ops email — do not change it to the root.)
2. **Place it (clickable `mailto:`) at the standard contact touchpoints:**
   - **Footer** — a "Contact" / "Support" link.
   - **Docs** — replace/augment the interim "DM @TeraHash on X" contact with the support email (keep the X
     handle alongside if desired).
   - **Help / Support** affordance (the ⊙ help icon / menu, if present).
   - **Legal / Privacy / Terms** pages — contact for legal/data requests.
   - The **"experimental / beta / as-is" disclaimer** — a contact for issues.
   - **Error boundaries / critical failure states** — "contact support: <email>".
3. `mailto:` links, accessible (aria), on-brand, responsive (mobile). Keep it tasteful (don't spam the email
   everywhere — the touchpoints above).
4. (Optional) a tiny obfuscation against naive scrapers is fine but not required; do NOT break the mailto.

## Do NOT
- Don't hardcode the email in multiple places — use the single constant. Don't set the value to the
  recovery-root ops email (owner sets a public address). Don't change business logic.

## Files affected (verify on main)
- A constants/config file (`SUPPORT_EMAIL`) + Footer + Docs (contact section) + Help/Support + Legal/Privacy/
  Terms + the disclaimer banner + error boundaries.

## Expected output
- Branch `chore/support-contact-email` off latest `origin/main`; SSH-signed; CI green; FEEDBACK listing every
  place the email was surfaced + the constant's location (so the owner sets the value). No Auditor (UI/content).

## Quality criteria
One `SUPPORT_EMAIL` constant drives a clickable support email at the footer, docs, help, legal pages,
disclaimer, and error states; value is owner-set (placeholder + warning comment, never the recovery root);
responsive + accessible; no scattered hardcoded emails.
