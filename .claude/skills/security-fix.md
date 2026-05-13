# Skill: Implementing Security Fixes

Apply this skill whenever the task references a finding id (e.g. `11-M-02`,
`CQL-03`, `INC-2026-04-14-001`) or modifies auth / rate-limiting / fund-flow
code paths.

## Before you start

- Read `docs/security/AUDIT-TOTAL.md` for the finding's full context (severity, scope, blast radius).
- Check the latest sprint packet in `docs/Prompts/SPRINT-*.md` — the prompt may have already constrained the fix shape.
- Cross-check related findings: if the same root cause appears in multiple places, fix them together unless the prompt explicitly scopes you to one.

## Commit message

- Format: `fix({scope}): {description} [{finding-id}]` — finding id in brackets, lowercase scope.
- Body: explain *why* the vulnerability matters, *what* you changed, and *which* tests pin the new behaviour.
- One atomic commit per prompt. No drive-by changes.

## Regression test (mandatory)

- Every security fix must include a test that fails on the vulnerable code and passes on the fixed code.
- Place the test adjacent to the fix (`*.test.ts` next to the source file).
- Cover at least: the exact attack vector from the finding, one variation, and one legitimate-input case to ensure no regression.

## Do not weaken

- Never disable an existing check to make the fix simpler. If two checks conflict, surface the conflict and ask.
- Never widen `unknown` to a concrete type without runtime validation.
- Never replace constant-time comparison with `===` on secret material.

## Error & log hygiene

- Sanitise any error message that may reach the client (no stack traces, no env-var names, no file paths) — see 11-M-02.
- Unify rejection messages on auth failure (no information leak about *why* auth failed) — see 11-M-03.
- Never log secrets, full API keys, or session tokens. Log length / hash prefix only when debugging is essential — see CQL-05 and api-auth.ts.

## CodeQL annotations

- For confirmed false positives, add an inline `// CodeQL: <query-id> — FALSE POSITIVE: <reason>` comment per the P87 pattern.
- For accepted risks, use `// CodeQL: <query-id> — ACCEPTED RISK: <reason>` and link the rationale.
- Never use `// eslint-disable` or `// @ts-ignore` to silence CodeQL.

## Cross-references

- Update `docs/security/AUDIT-TOTAL.md` to mark the finding closed (status + commit hash).
- If the fix changes auth or rate-limiting *behaviour* (not just shape), update the entire relevant test suite, not just the new test.
