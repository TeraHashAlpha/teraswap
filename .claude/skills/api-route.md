# Skill: Creating / Modifying API Routes

Apply this skill whenever the task creates or modifies a Next.js App Router
route under `src/app/api/**/route.ts`.

## File location

- Pattern: `src/app/api/{version}/{endpoint}/route.ts` (e.g. `src/app/api/v1/quote/route.ts`).
- Co-locate the test as `src/app/api/.../route.test.ts`.
- Public, versioned API → use the `v1/` segment. Internal/admin endpoints live under `api/admin/` or `api/monitor/`.

## Handler shape

- Export named handlers (`GET`, `POST`, ...) with `(req: NextRequest) => Promise<NextResponse>`.
- Validate every input before any business logic; reject early with `jsonError(400, '...')`.
- Never throw raw errors out of a handler — catch and return a sanitised `NextResponse`.
- Always return JSON. Error shape: `{ error: string }` with the appropriate HTTP status.

## Auth (v1)

- Wrap protected routes with `verifyApiKey()` from `@/lib/api-auth`.
- Every 401 path must use the unified rejection message (see 11-M-03) — do not leak why auth failed.
- API key plaintext is **never** logged; hashes only via `hashApiKey()` (SHA-256, see CodeQL annotation in `api-auth.ts`).

## Rate limiting

- Tier-based via `checkRateLimit(req, tier)` from `@/lib/rate-limiter`.
- Mock Upstash KV in tests — see `src/lib/kv-rate-limiter.test.ts` for the mocking pattern.
- Always set rate limit response headers on success and on 429.

## Validation

- Treat body fields as `unknown`; narrow with explicit `typeof` + value checks (see `src/app/api/v1/swap/route.ts:parseBody`).
- Addresses: `isValidAddress()` runtime check, not just TS template-type hints.
- BigInt-bearing fields: use `safeBigInt()` — never raw `BigInt()` on user input (10-L-01).
- Enums / source ids: validate against the constant Set (`KNOWN_SOURCES.has(x)`) before use.

## Security

- Never echo internal errors, stack traces, env-var names, or file paths back to the client (11-M-02).
- Sanitise any user input that ends up in response text.
- Swap routes: assert `usesFeeCollector()` — every v1 swap must collect the protocol fee via FeeCollector V2.

## Testing

- File: `route.test.ts` adjacent to `route.ts`.
- Mock external network (`vi.spyOn(global, 'fetch')` or per-adapter mocks).
- Mock `@upstash/redis` via the established pattern in `kv-rate-limiter.test.ts`.
- Cover: golden path, missing fields, invalid types, auth failure, rate-limit exceeded, security envelope.

## Imports

- Use `@/` path alias for everything inside `src/`. Never `../../../`.
- Do not import test-only modules into production code.
