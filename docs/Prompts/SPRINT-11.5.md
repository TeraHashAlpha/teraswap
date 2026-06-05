# Sprint 11.5 — Agent Skills + Supply Chain Hardening + CodeQL Fixes

**Sprint window:** Post-Sprint 11 APPROVED → TBD
**Sprint goal:** Harden the development pipeline (supply chain protection, static analysis fixes) and create reusable Agent Skills to accelerate future sprints. No user-facing features — pure DX and security hygiene.
**Owner:** TeraHash (founder/architect) + code agent
**Prerequisite:** Sprint 11 APPROVED (0C/0H/0M, 2026-05-12).
**References:**
- CodeQL scan results (2026-05-12): 12 HIGH findings triaged → 3 fix, 7 dismiss, 2 accept risk
- Mini Shai-Hulud npm supply chain attack (2026-05-11): TanStack/UiPath packages compromised
- Sprint 11 workflow analysis: Agent Skills + `/goal` + prompt format compacto
- Sprint 12 backlog: `docs/Prompts/SPRINT-11.md` (11-L-01 through 11-L-05)

---

## RICE Prioritisation

| # | Prompt | R | I | C | E | RICE | Priority |
|---|--------|---|---|---|---|------|----------|
| 83 | .npmrc supply chain hardening | 10 | 3 | 0.9 | 0.5 | 54.0 | P1 |
| 84 | CodeQL fix: TokenAddressBadge href injection | 6 | 2 | 0.9 | 0.5 | 21.6 | P1 |
| 85 | CodeQL fix: useTokenImport sanitisation | 8 | 3 | 0.9 | 0.5 | 43.2 | P1 |
| 86 | CodeQL fix: webhook secret logging | 3 | 1 | 1.0 | 0.25 | 12.0 | P2 |
| 87 | CodeQL dismiss annotations (7 FP) | 10 | 1 | 1.0 | 0.5 | 20.0 | P2 |
| 88 | Agent Skills — Code Agent (4 skills) | 10 | 3 | 0.8 | 3.0 | 8.0 | P2 |
| 89 | CLAUDE.md — Code Agent feedback loop | 10 | 2 | 0.8 | 0.25 | 64.0 | P1 |

**Execution order:** P83 → P84 → P85 → P86 → P87 → P89 → P88

**Dependency graph:**
```
P83 ──┐
P84 ──┤
P85 ──┼── P87 (dismiss annotations after fixes land)
P86 ──┘
P89 ── standalone
P88 ── standalone (can parallel with anything)
```

---

## Sprint status table

| # | Prompt | Description | Priority | Status |
|---|--------|------------|----------|--------|
| 83 | .npmrc supply chain hardening | Add min-release-age=7, lock registry, update CI comments | P1 | Pending |
| 84 | CodeQL fix: TokenAddressBadge href | Validate address before Etherscan href interpolation | P1 | Pending |
| 85 | CodeQL fix: useTokenImport sanitisation | Replace incomplete HTML strip regex with robust sanitiser | P1 | Pending |
| 86 | CodeQL fix: webhook secret logging | Remove partial secret from setup script logs | P2 | Pending |
| 87 | CodeQL dismiss annotations (7 FP) | Add inline suppress comments to 7 confirmed false positives | P2 | Pending |
| 88 | Agent Skills — Code Agent (4 skills) | Create .claude/skills/ with api-route, adapter, security-fix, supabase-migration skills | P2 | Pending |
| 89 | CLAUDE.md — Code Agent feedback loop | Add edge-case documentation convention to CLAUDE.md | P1 | Pending |

---

## Prompt 83 — .npmrc supply chain hardening

**Status:** Pending

**Context:** On 2026-05-11 the Mini Shai-Hulud supply chain attack compromised TanStack and UiPath npm packages within hours of publication. TeraSwap was not affected, but our `.npmrc` lacks proactive defences. We already have `ignore-scripts=true`, `save-exact=true`, and `legacy-peer-deps=true`. CI runs `npm ci --ignore-scripts=false` intentionally for prisma postinstall.

**Objective:** Add supply-chain-hardening directives to `.npmrc` so that fresh installs refuse packages published less than 7 days ago and lock to the official registry.

**Requirements:**

1. **Update `.npmrc`** — add these lines (keep existing three):
   ```
   registry=https://registry.npmjs.org/
   min-release-age=7d
   ```
   - `registry` — explicit registry pin, prevents `.npmrc` injection attacks redirecting to a rogue registry
   - `min-release-age=7d` — npm v11+ feature. Refuses to install any package version published less than 7 days ago. Blocks zero-day supply chain attacks like Mini Shai-Hulud

2. **Update CI comment block** in `.github/workflows/ci.yml` (lines 5-18, the `SECURITY NOTE (M-01)` block):
   - Add a point 4: `.npmrc min-release-age=7d refuses packages published < 7 days, blocking zero-day supply chain attacks`
   - Leave the rest of the CI file unchanged

3. **Add test** — a simple shell check in CI (new step in the `lockfile-lint` job, after existing steps):
   ```yaml
   - name: Verify .npmrc hardening
     run: |
       grep -q 'min-release-age' .npmrc || (echo "ERROR: .npmrc missing min-release-age" && exit 1)
       grep -q 'registry=https://registry.npmjs.org/' .npmrc || (echo "ERROR: .npmrc missing registry pin" && exit 1)
   ```

**Do NOT**

- Change `ignore-scripts=true` — this is intentional for local dev (CI overrides it)
- Remove `legacy-peer-deps=true` — required for current dependency tree
- Modify `npm ci --ignore-scripts=false` in CI — prisma needs it
- Add `--before` flags or other npm time-travel features

**Files affected**

- `.npmrc`
- `.github/workflows/ci.yml`

**Expected output**

- 1 atomic commit
- `.npmrc` has 5 lines (3 existing + 2 new)
- CI comment block updated with point 4
- lockfile-lint job has new verification step

**Quality criteria**

- `grep min-release-age .npmrc` returns the line
- `npm config list` shows `min-release-age=7d` in project config
- CI workflow YAML is valid (no syntax errors)

---

## Prompt 84 — CodeQL fix: TokenAddressBadge href injection (CQL-10)

**Status:** Pending

**Context:** CodeQL finding #10 (HIGH). `src/components/TokenAddressBadge.tsx:100` interpolates `address` directly into an Etherscan URL without validation. The component's TypeScript interface declares `address: \`0x${string}\`` but this is a compile-time-only constraint — at runtime, a malformed address (e.g. from imported tokens) could inject into the href.

**Objective:** Add runtime address validation before rendering the Etherscan link.

**Requirements:**

1. **Add an `isValidAddress` guard** before the `<a>` tag at line 98-112:
   - Use viem's `isAddress()` (already imported elsewhere in the project) to validate at runtime
   - If `isAddress(address)` is false, do not render the explorer link at all
   - Import `isAddress` from `viem` at the top of the file

2. **Alternative approach** (if simpler): validate in the component's early return:
   ```typescript
   const safeAddress = isAddress(address) ? address : null
   ```
   Then guard `showExplorerLink && safeAddress` in the JSX.

3. **Add a test** in the component's test file:
   - Render with a valid address → explorer link present
   - Render with `"not-an-address" as any` → explorer link absent, no crash

**Do NOT**

- Use `encodeURIComponent` alone — we want to reject invalid addresses entirely, not encode them
- Change the TypeScript interface type — keep the `0x${string}` hint
- Modify any other links in the component

**Files affected**

- `src/components/TokenAddressBadge.tsx`
- Test file for TokenAddressBadge (create if not exists)

**Expected output**

- 1 atomic commit
- No CodeQL alert on this file after fix
- Explorer link renders only for valid Ethereum addresses

**Quality criteria**

- `isAddress("0x1234...abcd")` → link rendered
- `isAddress("javascript:alert(1)")` → link NOT rendered
- No change to visual appearance for valid addresses
- TypeScript compiles cleanly

---

## Prompt 85 — CodeQL fix: useTokenImport sanitisation (CQL-03)

**Status:** Pending

**Context:** CodeQL finding #3 (HIGH). `src/hooks/useTokenImport.ts:117` uses `/<[^>]*>/g` to strip HTML tags from imported token name/symbol. This regex is incomplete — it fails on malformed tags like `<img src=x onerror=alert(1)`, unclosed tags, or encoded entities. Malicious ERC-20 contracts can return arbitrary strings in `name()` / `symbol()`.

**Objective:** Replace the incomplete regex with a robust sanitisation approach that eliminates all HTML/script injection vectors.

**Requirements:**

1. **Replace the regex-only approach** in `sanitizeTokenField()` (line 115-122) with a two-layer defence:

   **Option A (preferred — no new dependency):**
   ```typescript
   function sanitizeTokenField(raw: string, maxLen: number): string {
     // Layer 1: Remove anything that looks like HTML (aggressive — strip ALL angle brackets)
     const noAngles = raw.replace(/[<>]/g, '')
     // Layer 2: Allow only printable ASCII (existing filter)
     const cleaned = noAngles.replace(/[^\x20-\x7E]/g, '').trim()
     return cleaned.slice(0, maxLen)
   }
   ```
   This is strictly stronger: instead of trying to match complete tags (which fails on malformed HTML), it removes ALL `<` and `>` characters. Since no legitimate token name contains angle brackets, there's zero false-positive risk.

   **Option B (if team prefers a library):**
   - Install `dompurify` + `@types/dompurify` (or `isomorphic-dompurify` for SSR)
   - `DOMPurify.sanitize(raw, { ALLOWED_TAGS: [] })` → strips everything

2. **Add tests** for the sanitiser:
   - `<script>alert(1)</script>` → empty or "alert(1)" (no tags)
   - `<img src=x onerror=alert(1)>` → "img src=x onerror=alert(1)" or empty (no angle brackets)
   - `<div>Hello` (unclosed) → "Hello" or "divHello" (no angle brackets)
   - `Tether USD` (normal) → `Tether USD` (unchanged)
   - `USDC` → `USDC` (unchanged)
   - Empty string → empty string
   - String with maxLen exceeded → truncated

**Do NOT**

- Add a heavy dependency just for this — Option A (angle bracket removal) is preferred
- Change the `decodeString()` function below the sanitiser
- Modify how the hook calls `sanitizeTokenField`
- Remove the ASCII filter or maxLen truncation

**Files affected**

- `src/hooks/useTokenImport.ts`
- Test file for useTokenImport sanitiser (create if not exists)

**Expected output**

- 1 atomic commit
- `sanitizeTokenField` no longer uses `/<[^>]*>/g`
- All angle brackets removed regardless of well-formedness
- Tests pass for all edge cases above

**Quality criteria**

- CodeQL finding #3 no longer triggers
- No regression in legitimate token name display
- Zero external dependencies added (Option A)

---

## Prompt 86 — CodeQL fix: webhook secret logging (CQL-05)

**Status:** Pending

**Context:** CodeQL finding #5 (HIGH, accepted risk). `scripts/setup-telegram-webhook.ts:34` logs a partially masked webhook secret: `${WEBHOOK_SECRET.slice(0, 4)}...${WEBHOOK_SECRET.slice(-4)}`. While this is a one-shot setup script (not production code), leaking 8 characters of a secret reduces entropy. Trivial fix.

**Objective:** Remove the partial secret from the log output.

**Requirements:**

1. **Replace line 34** in `scripts/setup-telegram-webhook.ts`:
   ```typescript
   // Before:
   console.log(`Secret token: ${WEBHOOK_SECRET.slice(0, 4)}...${WEBHOOK_SECRET.slice(-4)}`)
   // After:
   console.log(`Secret token: [${WEBHOOK_SECRET.length} chars, set]`)
   ```
   This confirms the secret is set and shows its length (useful for debugging) without leaking any characters.

**Do NOT**

- Remove the log line entirely — knowing the secret is set is useful during setup
- Change any other part of the script
- Modify the webhook URL logging (that's not a secret)

**Files affected**

- `scripts/setup-telegram-webhook.ts`

**Expected output**

- 1 atomic commit
- No secret characters in any log output
- Script still confirms secret is present

**Quality criteria**

- `grep -r "slice(0, 4)" scripts/` returns nothing
- CodeQL finding #5 no longer triggers
- Script runs successfully (if testable)

---

## Prompt 87 — CodeQL dismiss annotations (7 false positives)

**Status:** Pending

**Context:** CodeQL scan (2026-05-12) flagged 12 HIGH findings. After triage, 7 are confirmed false positives. We need inline suppress comments so future scans don't re-flag them. CodeQL uses `// lgtm[query-id]` or GitHub code scanning can be dismissed via the UI, but inline comments are more durable.

**Objective:** Add explanatory comments to the 7 false-positive locations so reviewers and future CodeQL scans have context.

**Requirements:**

Add a comment block above each flagged line explaining why it's not a vulnerability. Format:

```typescript
// CodeQL: [query-id] — FALSE POSITIVE: [reason]
```

Locations and reasons:

1. **`src/lib/fingerprint-validator.ts:221`** — `rejectUnauthorized: false`
   ```typescript
   // CodeQL: js/disabling-certificate-pinning — FALSE POSITIVE:
   // Intentional. This TLS connection captures the server certificate fingerprint
   // for pinning validation. rejectUnauthorized:false is required to inspect
   // certificates from servers with untrusted/self-signed certs.
   ```

2. **`scripts/capture-endpoint-baseline.ts:53`** — `rejectUnauthorized: false`
   ```typescript
   // CodeQL: js/disabling-certificate-pinning — FALSE POSITIVE:
   // Same pattern as fingerprint-validator. Captures TLS fingerprints for baseline.
   // Dev-only script, not production code.
   ```

3. **`src/lib/source-state-machine.ts:189`** — template literal in console.warn
   ```typescript
   // CodeQL: js/code-injection — FALSE POSITIVE:
   // `id` is an internal SourceId constant from the SOURCES enum, never user input.
   ```

4. **`src/lib/source-state-machine.ts:245`** — template literal in console.error
   ```typescript
   // CodeQL: js/code-injection — FALSE POSITIVE:
   // `status.id` is an internal SourceId from the state machine, never user input.
   ```

5. **`src/app/api/v1/swap/route.ts:130`** — `source?: unknown` interface
   ```typescript
   // CodeQL: js/type-confusion — FALSE POSITIVE:
   // `unknown` is intentional — the field is validated and narrowed immediately below
   // via KNOWN_SOURCES.has() before any use.
   ```

6. **`src/app/api/v1/swap/route.ts:177`** — template literal with KNOWN_SOURCES
   ```typescript
   // CodeQL: js/code-injection — FALSE POSITIVE:
   // KNOWN_SOURCES is a hardcoded Set<string> constant, not user input.
   ```

7. **`src/lib/api-auth.ts:93`** — SHA-256 for API key hashing
   ```typescript
   // CodeQL: js/insufficient-key-size — ACCEPTED RISK:
   // API keys are 256-bit random strings (high entropy). SHA-256 is industry
   // standard for API key hashing (not passwords). bcrypt/scrypt are unnecessary
   // and would add latency to every API call. See: Stripe, GitHub, AWS patterns.
   ```

**Do NOT**

- Change any logic in these files — only add comments
- Use `// @ts-ignore` or `// eslint-disable` — those are for different tools
- Add comments to files being fixed in P84/P85/P86 (those fixes eliminate the finding)
- Dismiss findings via GitHub UI — inline comments are more durable across branch resets

**Files affected**

- `src/lib/fingerprint-validator.ts`
- `scripts/capture-endpoint-baseline.ts`
- `src/lib/source-state-machine.ts`
- `src/app/api/v1/swap/route.ts`
- `src/lib/api-auth.ts`

**Expected output**

- 1 atomic commit with all 7 annotations
- No logic changes in any file
- Comments explain the "why" for future reviewers

**Quality criteria**

- `grep -r "CodeQL:" src/ scripts/` returns exactly 7 matches
- TypeScript compiles cleanly
- No test regressions
- All comments are accurate (match the actual code at the flagged line)

---

## Prompt 88 — Agent Skills: Code Agent (4 skills)

**Status:** Pending

**Context:** Sprint 11 workflow analysis identified that the Code Agent (Claude Code) lacks domain-specific knowledge about TeraSwap's patterns. Each prompt repeats context about file locations, naming conventions, test patterns, and security constraints. Agent Skills (`.claude/skills/SKILL.md` files) teach the AI to follow project-specific patterns without repeating them in every prompt.

**Objective:** Create 4 reusable skill files that the Code Agent can reference, reducing prompt size and improving consistency.

**Requirements:**

1. **Create `.claude/skills/` directory** and 4 skill files:

2. **`.claude/skills/api-route.md`** — How to create/modify Next.js API routes in TeraSwap:
   - File location pattern: `src/app/api/{version}/{endpoint}/route.ts`
   - Must export typed handlers: `GET`, `POST` with `NextRequest` / `NextResponse`
   - Error handling: always return JSON `{ error: string }` with appropriate HTTP status
   - Auth pattern: `verifyApiKey()` middleware from `@/lib/api-auth` for v1 routes
   - Rate limiting: tier-based via `checkRateLimit()` from `@/lib/rate-limiter`
   - Validation: validate all inputs before business logic, reject early
   - Security: never expose internal errors, sanitise all user input in responses
   - FeeCollector V2 enforcement: `usesFeeCollector()` assertion for swap routes
   - Testing: co-locate test file as `route.test.ts`, mock Upstash KV for rate limits
   - Imports: use `@/` path alias, never relative imports crossing `src/` boundaries

3. **`.claude/skills/adapter.md`** — How to create/modify DEX source adapters:
   - File location: `src/lib/sources/{source-id}.ts`
   - Must implement `QuoteAdapter` interface from `@/lib/types`
   - Required: `getQuote()`, `buildSwapTx()`, optional `getSplitQuote()`
   - Error handling: throw `SourceError` (never generic Error), with `sourceId` and `reason`
   - Price validation: Chainlink oracle check mandatory for amounts > $0
   - Router whitelist: only addresses in `ROUTER_WHITELIST` constant
   - Calldata validation: `validateCalldata()` from `@/lib/swap-security`
   - Testing: unit test with mocked HTTP responses, integration test with forked mainnet
   - Naming: file name = source ID lowercase (e.g. `paraswap.ts`, `odos.ts`)

4. **`.claude/skills/security-fix.md`** — How to implement security fixes:
   - Always reference the finding ID (e.g. `11-M-01`, `CQL-03`) in commit message
   - Commit format: `fix({scope}): {description} [{finding-id}]`
   - Test requirement: every security fix must include a regression test proving the vulnerability is closed
   - Never weaken existing security checks to fix a different issue
   - Check `docs/security/AUDIT-TOTAL.md` before starting — understand the full finding context
   - If the fix changes auth/rate-limiting behaviour, update the corresponding test suite entirely
   - Log changes: if modifying error messages, ensure they don't leak internals (no stack traces, no env vars, no file paths)

5. **`.claude/skills/supabase-migration.md`** — How to make Supabase schema changes:
   - Always enable RLS on new tables
   - Default policies: deny-anon + service-role-full-access
   - Migration file location: `supabase/migrations/{timestamp}_{description}.sql`
   - Naming: snake_case for tables and columns
   - Always add `created_at TIMESTAMPTZ DEFAULT NOW()` and `updated_at` where appropriate
   - Indexes: add explicit indexes for columns used in WHERE clauses
   - Never store plaintext secrets — hash with SHA-256 (for API keys) or bcrypt (for passwords)
   - Test: verify RLS policies block anon access and allow service-role access

**Do NOT**

- Create skills for the Auditor role (that's a separate future task)
- Include project-specific secrets or API keys in skill files
- Add skill files to `.gitignore` — they should be committed
- Create overly long skills — each should be < 150 lines

**Files affected**

- `.claude/skills/api-route.md` (new)
- `.claude/skills/adapter.md` (new)
- `.claude/skills/security-fix.md` (new)
- `.claude/skills/supabase-migration.md` (new)

**Expected output**

- 1 atomic commit with all 4 skill files
- Each file is self-contained, actionable, < 150 lines
- Skills reference actual project paths, patterns, and conventions

**Quality criteria**

- A new Code Agent session can read `.claude/skills/api-route.md` and produce a correct API route without additional context
- No stale references (all file paths, imports, and patterns match current codebase)
- Consistent formatting across all 4 skills

---

## Prompt 89 — CLAUDE.md: Code Agent feedback loop

**Status:** Pending

**Context:** During Sprint 11, the Code Agent encountered several edge cases (BigInt handling, RLS configuration, rate limiter behaviour) that weren't documented. Currently, the Code Agent has no convention for flagging these discoveries back to the Architect. Adding a simple feedback convention to CLAUDE.md creates a bidirectional communication channel.

**Objective:** Add a "Code Agent Feedback" section to CLAUDE.md that instructs the Code Agent to document edge cases and surprises encountered during implementation.

**Requirements:**

1. **Add a new section to `CLAUDE.md`** after the "Do NOT" section (after line ~97), titled `## Code Agent Feedback Convention`:

   ```markdown
   ## Code Agent Feedback Convention

   When implementing a prompt, if you encounter any of the following, document it in a
   `FEEDBACK.md` file in the commit (root of repo):

   - **Edge case not covered by the prompt** — e.g. a function that also needs the fix but wasn't listed
   - **Assumption that turned out wrong** — e.g. an import path that changed, a deprecated API
   - **Security concern discovered during implementation** — e.g. an unvalidated input found while fixing a nearby one
   - **Test gap** — e.g. a code path with zero test coverage that's related to the change
   - **Performance concern** — e.g. a loop that's O(n²) on a growing dataset

   Format:
   ```
   ## Feedback — P{number} ({commit hash})

   ### Edge case
   - {description}

   ### Concern
   - {description}
   ```

   The Architect reviews FEEDBACK.md after each sprint and triages items into the backlog.
   ```

2. **The file is append-only** — each prompt adds its section, never removes previous entries.

3. **If no feedback** — the Code Agent should NOT create/modify FEEDBACK.md (don't add empty sections).

**Do NOT**

- Create FEEDBACK.md now — it's created by the Code Agent only when there's actual feedback
- Remove or modify any existing CLAUDE.md sections
- Add this convention to any file other than CLAUDE.md

**Files affected**

- `CLAUDE.md`

**Expected output**

- 1 atomic commit adding the feedback convention section
- Section is clear, actionable, and concise
- No other changes to CLAUDE.md

**Quality criteria**

- A Code Agent reading CLAUDE.md knows exactly when and how to create feedback entries
- Format is grep-friendly (`## Feedback — P` for easy extraction)
- Convention is lightweight — doesn't add overhead to simple prompts

---

## Post-sprint

After all prompts are committed and CI green:
1. Run full CodeQL scan — confirm findings #3, #5, #10 are resolved and 7 FPs have context
2. Run `npm audit --audit-level=high` — confirm 0 vulnerabilities
3. Verify `.npmrc` hardening with `npm config list`
4. Submit for auditor review (expect 0C/0H given scope is DX + hygiene)
5. Update `docs/security/AUDIT-TOTAL.md` with CodeQL triage decisions
6. Update project memory with Sprint 11.5 status
