# Feedback — fix/rpc-chain-identity-guard

## Where the guard lives, and its cache / re-verify intervals

Two new modules, plus wiring at the two call sites named in the prompt.

| File | Role |
|---|---|
| `src/lib/rpc-chain-identity.ts` | The verdict logic, the cache, and a plain-`fetch` JSON-RPC probe. No viem import, so an API route can use it. |
| `src/lib/rpc-guarded-transport.ts` | `guardedHttp(url, chainId, config)` — a drop-in for viem's `http()` that runs the guard before the first read. |
| `src/app/api/rpc/route.ts` | Calls `assertChainIdentity` after `getRpcUrlForChain`, before the forward. Mismatch ⇒ HTTP **502**, JSON-RPC code **-32006**, nothing forwarded. |
| `src/lib/wagmiConfig.ts` | Every transport (mainnet browser `/api/rpc`, mainnet server primary + 2 fallbacks + llamarpc last resort, Base, Arbitrum ×2) is now `guardedHttp`, never bare `http`. |

It follows `contracts/order-engine/executor/chain-verify.js` rather than inventing a second dialect:
the same `eth_chainId`-vs-configured-id check, the same **injected probe port** (so verification is
tested by injection, not by mocking a transport), the same bounded timeout, the same
name-both-values refusal style. It deliberately does **not** copy the keeper's fail-closed-on-
everything stance — see "The one judgement call" below.

**Verify once per `(chainId, endpoint)` per process, then cache.** Concurrent callers share a single
in-flight probe, so a cold instance taking 30 simultaneous requests pays one round-trip, not 30.

| Verdict | TTL | Why that number |
|---|---|---|
| `verified` | **30 min** | The only thing a TTL can catch is a provider silently re-pointing a URL — an ops env edit ships a new deployment, i.e. a new process, which re-verifies from cold anyway. 30 min bounds the exposure to minutes instead of the three **weeks** the incident ran, at a cost of one extra round-trip per chain per half hour on a warm instance. |
| `mismatch` | **60 s** | Shorter *on purpose*. While it stands we refuse from cache with no round-trip (a lying endpoint can't be turned into a request amplifier), but once ops corrects the endpoint the app recovers on its own within a minute. A sticky refusal would need a redeploy to clear — a second outage bolted onto the first. |
| `unverified` | **30 s** | This is the one verdict that lets traffic through unproven, so we want to be asking again soon. Not zero: re-probing every request during a provider outage would put exactly the per-request round-trip this module promises to avoid onto the hot path, at the worst possible moment. |

Probe timeout: **6 s** (`CHAIN_IDENTITY_PROBE_TIMEOUT_MS`), plus an `AbortController` on the fetch
probe so an accepted-then-silent endpoint is actually cancelled, not just abandoned.

## The verbatim mismatch error text

Asserted byte-for-byte by a test. For the production case (`expected 42161`, `reported 8453`):

```
RPC/chain mismatch — the RPC configured for chain 42161 reports chain 8453. Refusing to use it: an endpoint that answers for another chain returns wrong balances, wrong prices and wrong token metadata with no error at all. Point the chain-42161 RPC URL at chain 42161.
```

That exact string is: the `message` on the `mismatch` verdict; the `error.message` in the proxy's
502 body; and the message of the thrown `ChainIdentityError` (which also carries
`expectedChainId` / `reportedChainId` as fields). The `console.error` line is the same string
prefixed with `[chain-identity] `.

**The endpoint URL is deliberately absent from it.** RPC URLs routinely carry the provider key in
the path (`…/v2/<key>`) or the userinfo (`https://ops:<key>@host`), and this string reaches both a
server log and a client-facing JSON body. The two chain ids are the whole diagnosis. Pinned by
tests on both the proxy (`SUPERSECRETKEY` / host absent from the 502 body) and the transport.

## Acceptance results

1. **A test that FAILS when a chain's configured RPC reports a different chain id.** ✅ Four
   layers, each pointing one chain's URL at another chain's endpoint:
   - `src/lib/rpc-guarded-transport.test.ts` — the Arbitrum-configured URL answers `0x2105`; the
     read is refused, the error names 42161 and 8453, and `eth_getBalance` is *never sent*
     (`methodsSent` is exactly `['eth_chainId']`).
   - `src/lib/wagmiConfig.test.ts` — through the real wired `config.getClient({chainId})`.
   - `src/lib/wagmiConfig.server.test.ts` — the server-side mainnet ladder.
   - `src/app/api/rpc/route.test.ts` — `?chainId=42161` against a Base upstream ⇒ 502, both ids in
     the body, zero forwarded calls.
   Proof it isn't tautological: with the guard reverted to bare `http` on the mainnet transport,
   `wagmiConfig.server.test.ts` fails with `expected '0xdeadbeef' to contain 'chain 1'` and
   `expected [ 'eth_getBalance' ] to deeply equal [ 'eth_chainId' ]` — i.e. the incident itself.
2. **A test that an UNREACHABLE RPC still falls through and does NOT trip the guard.** ✅ Covered
   for transport reject, HTTP 5xx, JSON-RPC error envelope, malformed `eth_chainId`, and probe
   timeout — in the guard module, the transport, the wired wagmi config, and the proxy. In every
   case the read is still served and `console.error` is *not* called.
3. **A test that a read failure and a non-ERC-20 produce DIFFERENT messages.** ✅
   `src/hooks/useTokenImport.errors.test.ts`, including an explicit
   `expect(readFailure).not.toBe(notAToken)` and `expect(readFailure).not.toMatch(/not a valid/i)`.
4. **`/api/token-logo` serves 42161; lint + typecheck + touched suites pass.** ✅ 42161 resolves
   via CoinGecko's `arbitrum-one` list and falls back to the DefiLlama CDN; a registry-driven test
   asserts *every* `getSupportedChainIds()` chain is served. `npm run lint` exit 0 (94 warnings, at
   the existing `--max-warnings 94` ceiling — no new ones), `npm run typecheck` exit 0, and the
   **full** suite is **231 files / 3309 tests passing**.

## The one judgement call: what "malformed" means

The prompt names two outcomes — a different id (a lie) and no answer (an outage). A **malformed**
`eth_chainId` (`0x`, `"nope"`, an object) is neither: it proves the endpoint is unhealthy, not that
it is another chain, and a refusal that must "name both chain ids" cannot be issued when the second
value is garbage. It is therefore classified **`unverified`** (fall through, warn), not `mismatch`.
This is the one place the app guard diverges from the keeper's boot gate, which refuses on
malformed — correct there, because it is a one-shot gate for a fund-moving process with no fallback
ladder behind it. Flagging explicitly in case the Architect wants the stricter reading.

## Concern — there is a THIRD place that resolves an upstream, and it is still unguarded

`src/lib/chains/clients.ts` (`getPublicClientForChain`) builds `http(url)` / `fallback([http…])` per
chain straight from `registry.rpc.primary` + `rpc.fallbacks`, for every **non-mainnet** chain. It is
the server-side client behind quote simulation, portfolio and the on-chain monitor — so during the
incident window it had exactly the same exposure as the wagmi transports, from the same env var, and
it still does. It is outside this prompt's `Files` list so I did not touch it; the change is
mechanically a `http(` → `guardedHttp(` swap now that the module exists, but it sits on the quote
path, so it deserves its own scoped change and its own audit rather than riding along here.

Two smaller siblings, both mainnet-only and lower risk: `src/lib/rpc.ts` (`DIRECT_RPC_URL`, the
SSR/API-route direct path — the browser path goes through `/api/rpc`, which *is* guarded now) and
`src/lib/on-chain-monitor.ts`.

## Edge case — a mismatch inside a `fallback([...])` advances rather than hard-stopping

A `ChainIdentityError` carries no numeric JSON-RPC `code`, so viem's `fallback` does not treat it as
fatal and moves to the next transport — which carries its own independent guard. I believe this is
the right behaviour and have documented it in the module: the mismatching endpoint's response is
never passed through, the refusal is logged loudly, and the array can only ever serve an endpoint
that proved its identity or fail outright. Concretely, Arbitrum's ladder is
`[NEXT_PUBLIC_ARBITRUM_RPC_URL, arb1.arbitrum.io]` — during the incident the guard would have
refused entry 1 and served correct Arbitrum data from entry 2, loudly. Raising it here because
"advances to the next transport" could be *read* as degrading, and it is a deliberate choice, not an
oversight.

## Edge case — a JSON-RPC error is treated as "could not read", not "not a token"

In `useTokenImport`, an `error` envelope from `eth_call` counts as `unreadable`. A revert *can* mean
the contract lacks `symbol()`, so this over-reports "we could not read it" for genuinely broken
tokens. That is the intended bias and it follows the prompt's rule literally ("only a successful
read that fails the ERC-20 shape may call the token invalid"): over-reporting costs a retry,
under-reporting calls a user's token fake because our RPC was broken.

## Test gap left in place — `'Could not read token data'`

`useTokenImport` has a pre-existing third message for a read that *succeeded* but whose bytes would
not decode (empty symbol, `NaN` decimals). By the prompt's rule that is a successful read failing
the ERC-20 shape, so it arguably belongs under `TOKEN_NOT_ERC20_MESSAGE` — its current wording
("could not read") now points the finger at the transport, which is the mirror of the bug being
fixed. Left untouched as out of scope; the new transport message leads with "Network error —" so
the two are not confusable in the UI.

## Assumption corrected mid-implementation — the browser mainnet transport can't be tested in jsdom

`wagmiConfig.test.ts` runs under jsdom, where the mainnet transport is the relative `/api/rpc`.
viem builds a `new Request(url)` before fetching, and no non-browser runtime can construct one from
a relative path (`Failed to parse URL from /api/rpc`) — this is true with or without the guard.
Hence the new `src/lib/wagmiConfig.server.test.ts` (node env, absolute `NEXT_PUBLIC_RPC_URL`), which
covers the server ladder; the browser branch is covered structurally plus by the
`guardedHttp` unit tests.

## Test-surface facts worth knowing

- `vi.spyOn(console, 'error')` on an already-spied method returns the **same spy with its call
  history intact**. Without a `vi.restoreAllMocks()` first, a later case sees an earlier case's
  refusals — it cost one false failure here (`expected "error" to not be called at all, but
  actually been called 6 times`).
- `addCustomToken` appends to a **module-level array** in `lib/tokens`, which `localStorage.clear()`
  cannot reach. Hook tests that import a token must use a fresh address per case or
  `findChainToken` short-circuits the next one.
- `src/app/api/rpc/route.test.ts` now stubs `resolveProxyChainId` / `getRpcUrlForChain` through
  `vi.hoisted` so a case can choose the chain; upstream call assertions filter out the identity
  probe via `forwardedCalls()`.

## Not touched, per the prompt

No CSP host added (the guard's probe always uses the *same* URL as the transport it guards, so no
new origin is contacted). No RPC URL or env var changed. No `.sol`, keeper, or order-engine config.
No file deleted.

---

## Follow-up — closing the third resolver (`getPublicClientForChain`)

`src/lib/chains/clients.ts` — flagged above and left alone as out of scope for the original PR — is
now guarded too. It feeds `useSwap`/`useSplitSwap` (client), `on-chain-monitor.ts`, `price-monitor.ts`,
`api.ts`, `chainlink.ts`, `post-execution-validator.ts`, `dca/settlement-receipt.ts`, and
`/api/swap/route.ts`, so an unguarded endpoint here is the same silent-lie failure mode reaching
quote simulation, portfolio, and the sequencer-uptime read, not just the Chainlink feed hook.

### The three transport shapes, and the decision on shape 3

`configuredUrls = [config.rpc.primary, ...config.rpc.fallbacks].filter(Boolean)`:

1. one URL → `guardedHttp(url, chainId)` (was `http(url)`)
2. several → `fallback(urls.map(url => guardedHttp(url, chainId)))` (was `fallback([...http(url)])`)
3. **zero** → previously bare `http()`, letting viem silently resolve its own default public RPC
   for the chain (`arb1.arbitrum.io` / `mainnet.base.org`, per `viem/chains`).

Shape 3 is currently unreachable for Base and Arbitrum specifically: both registry entries hardcode
a non-empty `fallbacks` array (`['https://mainnet.base.org']` / `['https://arb1.arbitrum.io/rpc']`),
so `configuredUrls` is never empty for them today. It is real defensive surface for any future chain
registered without an RPC entry, and the prompt asked for a decision on it regardless.

**Decision: guard it too, against the chain's own known default.** viem's default for a chain is a
specific, discoverable URL — `chain.rpcUrls.default.http[0]` — not a mystery; I resolve that URL
explicitly and route it through the identical `guardedHttp` used for a configured one, rather than
carving out the one path this whole module exists to stop leaving unverified:

```
const urls = configuredUrls.length > 0 ? configuredUrls : (chain?.rpcUrls.default.http ?? [])
```

**Why not leave it bare, as "implicitly correct by construction":** the guard's own docblock says it
plainly — *"implicitly is not verified, and that is the whole point of this branch."* Viem's default
being "that chain's own public endpoint" is true by viem's own source, but the incident's actual
lesson was that a config value silently answering for the wrong chain is invisible at every layer
below the transport — a hardcoded literal is not exempt from that failure mode, it is just a
different place the mistake could live (a copy-paste of the wrong chain's default into `VIEM_CHAINS`,
a future viem major renumbering a `rpcUrls.default` entry, etc.). Guarding it costs nothing extra: it
is the same one-probe-per-process-per-endpoint the configured-URL path already pays. The only
remaining unguarded fallback is the innermost `urls.length === 0` branch — reachable only if a viem
`Chain` object itself carried zero default RPC URLs, which is not true for any chain in
`VIEM_CHAINS` today and would be a viem-library-level anomaly, not a config error this branch can
meaningfully probe against (there is no URL to guard).

### The cache trap — investigated, confirmed NOT a bug

`clientCache` caches one `PublicClient` per chain for the process lifetime, but the identity check
is **not** performed once at client construction — it lives inside the `request` closure that
`guardedHttp` returns, which is invoked on every actual RPC call the cached client makes. That
closure calls `assertChainIdentity(...)` fresh each time, and `assertChainIdentity` is the one that
owns the TTL cache (verified 30 min / mismatch 60 s / unverified 30 s), keyed by
`(expectedChainId, endpoint)` — entirely independent of `clientCache`. So:

- The **client** object is cached and reused (unchanged behaviour, still one `createPublicClient`
  call per chain).
- The **verdict** is cached separately with its own short TTL, and is re-evaluated on every request
  the moment that TTL lapses — with no client-cache invalidation, no new `PublicClient`, no
  redeploy.

Proven directly in `clients.identity-guard.test.ts` ("the SAME cached PublicClient recovers from a
mismatch once the mismatch TTL elapses"): a mismatching endpoint is refused twice back-to-back (one
network probe, one cache hit — proving the TTL, not zero caching), then, on the exact same
`PublicClient` reference (`getPublicClientForChain(ARBITRUM)` returns `===` the original), once fake
time crosses `CHAIN_IDENTITY_MISMATCH_TTL_MS` the SAME cached client re-probes (fetch call count
2→confirmed) and serves the read once the upstream is corrected — no cache clear, no new client. No
fix was needed; the design already keeps these two caches orthogonal by construction (the guard sits
inside the transport's per-request closure, not at transport-construction time).

### Files touched

- `src/lib/chains/clients.ts` — the three-shape routing above; mainnet branch
  (`chainId === DEFAULT_CHAIN_ID → getPrivateClient()`) untouched, still the first line of the
  function, still returns before the registry/guard branch is reached at all.
- `src/lib/chains/clients.fallback.test.ts` — the pre-existing "fails over to the registry fallback
  RPC" test's fetch mock answered `eth_chainId` with the block-number stub value for the FALLBACK
  host (a leftover from before this branch existed) — now a guardedHttp transport, that would have
  read as a genuine chain mismatch rather than the HTTP-error failover the test is about, so both
  hosts now answer `eth_chainId` correctly (`0x2105`) and the real read is what varies by host. The
  "single configured URL" test's name/comment updated from "no wrapper" to reflect that it IS
  wrapped now (guardedHttp preserves viem's `transport.type: 'http'`, so the assertion itself did
  not need to change).
- `src/lib/chains/clients.identity-guard.test.ts` (new) — the acceptance tests below, plus shape-3
  coverage (mismatch and outage against the chain's own default URL, with no registry entry at all).

### Acceptance results

1. **Mismatch trips the guard through `getPublicClientForChain`, naming both ids verbatim** — three
   tests: single-URL shape, the `ChainIdentityError` object's `expectedChainId`/`reportedChainId`,
   and the two-URL `fallback()` shape (`client.transport.type === 'fallback'`, still refused). ✅
2. **An unreachable RPC through this path still falls through** — probe throws (`ECONNRESET`) and a
   probe 5xx, both resolve the real read normally, no `ChainIdentityError`. ✅
3. **The mainnet path is unchanged** — `getPublicClientForChain(1)` still returns two DIFFERENT
   objects on repeat calls (the documented "intentionally per-call" behaviour of `getPrivateClient`,
   which a cached or guard-wrapped client would not exhibit), and a chain-1 read needs no fetch stub
   at all — it never reaches the registry/guard branch. Reference-equality to a fresh
   `getPrivateClient()` call was tried first and is the WRONG assertion (that factory itself never
   returns the same object twice, guard or no guard); the per-call/no-cache behaviour is the
   meaningful proof and is what the test asserts. ✅
4. **The client cache does not pin a stale verdict** — described above; one test, fake timers,
   asserts both the object identity (`===`) across the TTL boundary and the fetch call count
   (1 → still 1 on an immediate re-read → 2 after the TTL elapses and the upstream is corrected). ✅
5. **Full suite + lint/typecheck** — `npx vitest run`: 232 files / 3330 tests green (was 3310 before
   this follow-up; +20 from the two touched/new client test files, net of the fallback-test mock
   fix). `npx tsc --noEmit`: clean. `npx eslint . --max-warnings 94`: exit 0, 94 warnings (at the
   existing ceiling, unchanged files list — none of the 94 are in the files this follow-up touched). ✅

### Note

An initial version of the cache-trap test also tried to cover the UNVERIFIED-verdict TTL (shorter,
30 s) alongside the MISMATCH one, combining fake timers with an induced fetch rejection. Dropped it:
viem's `http()` transport has its own internal retry/backoff (default `retryCount: 3`) on a genuine
network rejection, scheduled via real `setTimeout` calls that fake timers do not advance
automatically — the combination hung past vitest's default test timeout. `retryCount: 0` is what
`rpc-guarded-transport.test.ts` passes to sidestep exactly this, but adding it to the production
`guardedHttp` calls in `clients.ts` would be an unrequested change to this file's existing retry
behaviour (it had no `retryCount` override before this branch either), so I left production code
alone and removed the one test that needed it — the MISMATCH-TTL test already fully proves
acceptance criterion 4 on its own.

---

## Follow-up — CodeQL log-injection hardening on `rpc-chain-identity.ts`

CodeQL raised two Medium `js/log-injection` alerts on this file: the `console.error` on the
mismatch path and the `console.warn` on the unverified path.

### Sweep — every log/throw/error-body site in the file that carries text

- **2 log sinks fixed** (the two CodeQL flagged, and the only two `console.*` calls in the file):
  `console.error` (mismatch, logs `verdict.message`) and `console.warn` (unverified, logs
  `verdict.reason`).
- **1 upstream-text source audited, no separate fix needed:** `createJsonRpcChainIdProbe` throws
  `Error(\`eth_chainId probe returned a JSON-RPC error: ${json.error.message ?? 'unknown'}\`)` —
  `json.error.message` is genuinely upstream (the RPC's own JSON-RPC error envelope). It is caught
  in `verifyChainIdentity`'s catch block and already flows through `errText` (→
  `sanitizeUpstreamError`) into `verdict.reason`, i.e. through the same pipeline the fix now also
  neutralizes for newlines at the log sink — so no independent fix was needed there.
- **Dismissed as not upstream text:** the probe-timeout `Error` (line ~148, only interpolates our
  own `timeoutMs` number), the malformed-`eth_chainId` literal string, and the non-ok-HTTP-status
  `Error` (only interpolates `res.status`, a number, not free text).
- **No throw or error-body sink in this file** — `verifyChainIdentity`/`assertChainIdentity` never
  throw (by design, per the module docblock), and this file writes no HTTP response bodies (that
  happens in `/api/rpc`'s route handler, out of scope — Files list is this file and its tests).

Total: **2 sinks changed**.

### Why sanitizeUpstreamError alone didn't satisfy CodeQL, and what closes the real gap

`verdict.reason` was already routed through `sanitizeUpstreamError` (via the existing `errText`
helper) before this change — so the provider-key-redaction acceptance tests (2, 2b) pass **even
against the pre-fix file**, confirmed by reverting the fix and re-running: only the newline tests
(3, 3b, and the TTL-cache one) fail against the reverted file. `sanitizeUpstreamError` targets
secrets (URL path/query, Bearer tokens, key/secret/token/password assignments) — it does not touch
`\r`/`\n`, because its original job (SPRINT-9J J2) is a client-facing JSON error body, where a
literal newline is cosmetic. A `console.*` sink is different: an upstream error with an embedded
`\n[chain-identity] fake verdict` line could forge a second, independent-looking log entry — which
is the actual log-injection primitive CodeQL's query is watching for, and it survives secret
redaction untouched.

Since `sanitize-error.ts` is read-only for this task (it's shared — used elsewhere for
client-facing bodies, where adding newline-stripping wasn't asked for and is out of scope), the fix
adds a **local** barrier in `rpc-chain-identity.ts`:

```ts
const forLog = (text: string): string => sanitizeUpstreamError(text).replace(/[\r\n]/g, ' ')
```

Applied at both sinks: `forLog(verdict.message)` (mismatch) and `forLog(verdict.reason)`
(unverified). Re-running `sanitizeUpstreamError` there is redundant for `verdict.reason` (already
sanitized once via `errText`) but idempotent and harmless, and it puts the secret-redaction call
directly adjacent to the sink — the standard shape for satisfying a static dataflow scanner that
may not track through an intermediate named wrapper with full precision.

### `verdict.message` — composed by us, sanitized anyway, verified byte-identical

Empirically confirmed (`node` script, then pinned as a test) that `forLog(chainIdentityMismatchMessage(...))`
is character-for-character identical to the unwrapped string: no URL, no `Bearer`, and — despite
containing the substring "token" (`"wrong token metadata"`) — no `key=`/`secret=`/`token=`-style
assignment for the redaction regex to match, and no newline. `chainIdentityMismatchMessage` itself,
`ChainIdentityError`, and every other read of `verdict.message` are untouched by this change; only
the *logged* copy at the one `console.error` call site is wrapped.

### Acceptance results

1. **Verbatim mismatch message byte-identical** — `chainIdentityMismatchMessage(42161, 8453)` string-
   pinned exactly (and matches the `/chain 42161.*chain 8453/s` shape asserted elsewhere), plus a
   separate assertion that the *logged* text via `console.error` is that identical string
   (`toHaveBeenCalledWith`). All four other files on this branch that assert this message —
   `rpc-chain-identity.test.ts` (own suite, pre-existing `.toBe()` assertion, line 85, untouched),
   `rpc-guarded-transport.test.ts`, `wagmiConfig.test.ts`, `clients.identity-guard.test.ts` — run
   green, unmodified (31/31). ✅
2. **Provider key in an RPC URL path does not reach the log unredacted** — asserted for a
   path-embedded key (`.../v2/<key>`) and, separately, a Bearer token and a `key=` assignment. ✅
3. **A newline-bearing upstream error cannot forge a second log line** — asserted `console.warn` is
   called exactly once, the logged string contains no `\r`/`\n`, and (separately) a lone `\r` with
   no `\n` is also neutralized. **This is the test that actually discriminates the fix**: reverted
   the two sinks back to raw interpolation, re-ran the suite — 3 tests failed (the newline ones;
   the secret-redaction ones still passed, since that redaction already existed pre-fix via
   `errText`) — then restored the file byte-identical (`diff` confirmed) and re-ran green (32/32). ✅
4. **Full suite / lint / typecheck** — `tsc --noEmit`: clean. `eslint . --max-warnings 94`: exit 0,
   94 warnings (0 errors, at the existing ceiling, none in the touched file). Full `vitest run`:
   232 files / 3338 tests green (was 3330 before this follow-up; +8 new cases in
   `rpc-chain-identity.test.ts`). ✅

### Not touched, per the goal

No change to the guard's decision logic, TTLs, cache keys, or fall-through behaviour — `forLog` is
a pure logging-time wrapper around already-final `verdict.message`/`verdict.reason` strings; the
`ChainIdentityVerdict` shape, `assertChainIdentity`'s caching, and `verifyChainIdentity`'s
classification are byte-for-byte what they were before this commit. `sanitize-error.ts` untouched
(read-only, per the Files list).
